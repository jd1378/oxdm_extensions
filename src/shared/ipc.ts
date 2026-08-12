// IPC client to oxdm. Two transports:
//
//   - 'ws'      — direct WebSocket to ws://127.0.0.1:<port>. Requires a
//                 token from the extension's Options page.
//   - 'native'  — browser.runtime.connectNative(<hostName>). The
//                 oxdm-native-host binary auto-discovers port + token
//                 from oxdm.db, so the extension does not handle them.
//
// 'auto' transport tries native first; on connect failure (binary
// missing, manifest absent, etc.) it falls back to WS. Each successful
// connect is sticky for the session.
//
// Wire format is identical on both paths: tagged JSON requests with an
// `id` correlation field; replies carry the same `id`.

import type {
  OutboundRequest,
  Response,
  CaptureRequest,
  CaptureRulesWire,
  QueueSummary,
} from './messages';
import { NATIVE_HOST_NAME, type Transport } from './state';

type Pending = (r: Response) => void;

export type ConnState =
  | 'disconnected'
  | 'connecting'
  | 'reconnecting'
  | 'connected'
  | 'token-rejected'
  | 'error';

export interface ConnError {
  /** Transport in use when the error fired, or null if undetermined. */
  transport: 'native' | 'ws' | null;
  /** Short, human-readable. */
  message: string;
}

interface TransportImpl {
  send(payload: string): boolean; // false → not open, caller should queue
  close(): void;
}

export class OxdmClient {
  private impl: TransportImpl | null = null;
  private activeTransport: Exclude<Transport, 'auto'> | null = null;
  private state: ConnState = 'disconnected';
  private pending = new Map<string, Pending>();
  private queue: string[] = [];
  private nextId = 1;
  private backoffMs = 1000;
  private port = 27812;
  private token = '';
  private transportPref: Transport = 'auto';
  private listeners = new Set<(s: ConnState) => void>();
  private errorListeners = new Set<(e: ConnError) => void>();
  private autoFellBackToWs = false;
  /**
   * Latched after a WS auth rejection. Suppresses further WS
   * attempts (and stops the reconnect loop entirely when transport
   * is explicit 'ws') until `configure()` sees a different token.
   * The user must paste a new pairing code to unblock.
   */
  private wsTokenBlocked = false;
  /**
   * Set by the first `ensureOpen()`. Keeps a close/error that fires
   * during teardown from scheduling a reconnect nobody asked for.
   */
  private wantConnection = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  configure(opts: {
    port: number;
    token: string;
    transport: Transport;
  }) {
    // Tear down only when the live connection can no longer satisfy
    // the new preference. Lets background "pin" a working transport
    // (auto → ws) without dropping the session that just came up.
    const tokenChanged = opts.token !== this.token;
    const transportSatisfied =
      this.activeTransport != null &&
      (opts.transport === 'auto' ||
        opts.transport === this.activeTransport);
    const changed =
      opts.port !== this.port ||
      tokenChanged ||
      (opts.transport !== this.transportPref && !transportSatisfied);
    this.port = opts.port;
    this.token = opts.token;
    this.transportPref = opts.transport;
    // A new token unblocks the WS path so the user can recover from
    // a previous rejection by simply pasting a fresh pairing code.
    if (tokenChanged && this.wsTokenBlocked) {
      this.wsTokenBlocked = false;
      // If we were sitting in 'token-rejected', drop back to a
      // neutral state so ensureOpen can take it from here.
      if (this.state === 'token-rejected') {
        this.setState('disconnected');
      }
    }
    if (changed) {
      this.autoFellBackToWs = false;
      if (this.impl) {
        try {
          this.impl.close();
        } catch {}
        this.impl = null;
      }
      // Caller (background's applyClientConfig) drives ensureOpen
      // separately; we just tear down here.
    }
  }

  /** Live transport (null if not connected). Lets callers learn what
   * 'auto' resolved to so they can persist a preference. */
  getActiveTransport(): 'native' | 'ws' | null {
    return this.activeTransport;
  }

  getTransportPref(): Transport {
    return this.transportPref;
  }

  onState(cb: (s: ConnState) => void) {
    this.listeners.add(cb);
    cb(this.state);
    return () => this.listeners.delete(cb);
  }

  onError(cb: (e: ConnError) => void) {
    this.errorListeners.add(cb);
    return () => this.errorListeners.delete(cb);
  }

  private emitError(message: string) {
    const e: ConnError = { transport: this.activeTransport, message };
    for (const l of this.errorListeners) l(e);
  }

  getState() {
    return this.state;
  }

  private setState(s: ConnState) {
    if (s === this.state) return;
    this.state = s;
    for (const l of this.listeners) l(s);
  }

  ensureOpen() {
    this.wantConnection = true;
    if (this.impl) return;
    const tryNative =
      this.transportPref === 'native' ||
      (this.transportPref === 'auto' && !this.autoFellBackToWs);
    if (tryNative && this.openNative()) return;
    if (this.transportPref === 'native') {
      // Native explicitly requested but unreachable. Stay in error
      // state; do not silently switch to WS.
      this.emitError(
        buildNativeErrorReason('connectNative() unavailable in this browser'),
      );
      this.setState('error');
      this.scheduleReconnect();
      return;
    }
    // WS attempt — gated by the token-blocked latch.
    if (this.wsTokenBlocked) {
      // No new attempts until configure() sees a fresh token.
      this.setState('token-rejected');
      return;
    }
    this.openWs();
  }

  private openNative(): boolean {
    if (typeof browser === 'undefined' || !browser.runtime.connectNative) {
      return false;
    }
    let port: any;
    try {
      port = browser.runtime.connectNative(NATIVE_HOST_NAME);
    } catch {
      this.autoFellBackToWs = this.transportPref === 'auto';
      return false;
    }
    this.setState('connecting');
    this.activeTransport = 'native';
    const connectStartedAt = Date.now();
    // Same awaiting-auth pattern as WS: `connectNative` returning a
    // port object doesn't mean the shim is actually wired through
    // to oxdm. The shim could exit on the next tick if oxdm is down
    // or its WS auth fails. Promote to 'connected' only when
    // either (a) the shim forwards a first message back, or (b) a
    // grace passes without onDisconnect firing.
    let awaitingAuth = true;
    const promoteToConnected = () => {
      if (!awaitingAuth) return;
      awaitingAuth = false;
      if (this.impl === null) return;
      this.backoffMs = 1000;
      this.setState('connected');
    };
    // 2.5s grace — native path needs a process spawn + WS upgrade
    // + auth round-trip inside the shim, so it's slower than the
    // direct WS path's 1.5s.
    setTimeout(promoteToConnected, 2500);
    port.onMessage.addListener((msg: any) => {
      promoteToConnected();
      if (typeof msg !== 'string') {
        try {
          msg = JSON.stringify(msg);
        } catch {
          return;
        }
      }
      this.handleMessage(msg as string);
    });
    port.onDisconnect.addListener(() => {
      const err = (browser.runtime as any).lastError ?? (port as any).error;
      const raw = err?.message ?? 'native host disconnected';
      const elapsedMs = Date.now() - connectStartedAt;
      const wasConnected = this.state === 'connected';
      const reason = buildNativeErrorReason(raw, { elapsedMs, wasConnected });
      awaitingAuth = false;
      this.impl = null;
      this.activeTransport = 'native';
      this.emitError(reason);
      this.activeTransport = null;
      this.setState('disconnected');
      this.failAllPending(reason);
      // First-time failure on 'auto' → fall back to WS on next ensureOpen.
      if (this.transportPref === 'auto' && !wasConnected) {
        this.autoFellBackToWs = true;
      }
      this.scheduleReconnect();
    });

    this.impl = {
      send: (payload) => {
        try {
          port.postMessage(JSON.parse(payload));
          return true;
        } catch {
          return false;
        }
      },
      close: () => {
        try {
          port.disconnect();
        } catch {}
      },
    };

    // Flush any queued requests immediately. If the shim turns out
    // to be dead, onDisconnect fails them via failAllPending.
    // 'connected' is announced separately by `promoteToConnected`.
    queueMicrotask(() => {
      if (this.impl === null) return;
      for (const m of this.queue) this.impl.send(m);
      this.queue = [];
    });
    return true;
  }

  private openWs() {
    this.setState('connecting');
    this.activeTransport = 'ws';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
    } catch (e) {
      this.emitError(`WebSocket construct failed: ${(e as Error)?.message ?? String(e)}`);
      this.setState('error');
      this.scheduleReconnect();
      return;
    }
    this.impl = {
      send: (payload) => {
        if (ws.readyState !== 1) return false;
        ws.send(payload);
        return true;
      },
      close: () => {
        try {
          ws.close();
        } catch {}
      },
    };
    // Wire has no positive ack for the auth frame — oxdm just
    // closes the socket on bad token. So we flag "awaiting auth"
    // between sending the frame and either a server reply landing
    // (proves the server accepted us) or a 1.5 s grace passing
    // without a close (no rejection = implicit acceptance).
    //
    // We deliberately stay in 'connecting' until the flag clears so
    // consumers that piggy-back on the 'connected' transition (e.g.
    // syncRules) only run after auth is verified. Otherwise an
    // unauth'd rules request would race the server's close and
    // produce a spurious failure log.
    let awaitingAuth = false;
    const promoteToConnected = () => {
      if (!awaitingAuth) return;
      awaitingAuth = false;
      if (this.impl === null) return; // closed in the meantime
      this.backoffMs = 1000;
      this.setState('connected');
    };
    ws.addEventListener('open', () => {
      awaitingAuth = true;
      ws.send(JSON.stringify({ token: this.token }));
      // Flush queued requests right away — if auth fails, the close
      // handler's `failAllPending` will reject them. No upside to
      // sitting on them during the verification grace.
      for (const m of this.queue) ws.send(m);
      this.queue = [];
      // No positive ack from oxdm on success, so fall back to a
      // grace timer for quiet but valid sessions.
      setTimeout(promoteToConnected, 1500);
    });
    ws.addEventListener('message', (ev) => {
      // First server message = proof oxdm processed our auth and
      // is now talking to us. Promote ahead of the grace timer.
      promoteToConnected();
      this.handleMessage(ev.data);
    });
    ws.addEventListener('close', (ev) => {
      // If close fires while we're still waiting for the first
      // server-originated reply, attribute it to auth rejection.
      // Otherwise surface the close code verbatim.
      const tokenRejected = awaitingAuth;
      const reason = tokenRejected
        ? 'token rejected by oxdm; paste a fresh pairing code from oxdm Settings'
        : ev.reason ||
          `socket closed (code ${ev.code}${ev.wasClean ? '' : ', abnormal'})`;
      this.impl = null;
      this.emitError(reason);
      this.activeTransport = null;
      this.failAllPending(reason);
      if (tokenRejected && this.transportPref === 'ws') {
        // Explicit WS choice: latch and stop the loop entirely.
        // The user picked this transport, so silently rotating to
        // native would defy their intent. They must update the
        // pairing code to unblock.
        this.wsTokenBlocked = true;
        this.setState('token-rejected');
        return;
      }
      // In auto mode, any WS failure (token rejection, server
      // missing, abnormal close) should flip the rotation back to
      // native for the next cycle. Otherwise `autoFellBackToWs`
      // stays sticky and we'd keep trying only WS forever.
      if (this.transportPref === 'auto') {
        this.autoFellBackToWs = false;
      }
      this.setState('disconnected');
      this.scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      // Browsers do not expose the underlying error to WebSocket
      // `error` handlers for security reasons; we only know that
      // something went wrong. The follow-up `close` carries the
      // code, and `awaitingAuth` lets us flag token rejection there.
      this.emitError('WebSocket error (oxdm likely not listening on port)');
      this.setState('error');
    });
  }

  private scheduleReconnect() {
    if (!this.wantConnection) return;
    if (this.reconnectTimer) return;
    const delay = this.backoffMs;
    // Surface that we're between attempts so the UI can show a
    // distinct badge instead of "disconnected" → snap to "connecting".
    this.setState('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wantConnection) this.ensureOpen();
    }, delay);
    // Aggressive cap — oxdm being closed is the common case, not an
    // error to recover from in seconds. 60s keeps the loop alive for
    // the moment the user starts oxdm without flooding console.
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
  }

  private failAllPending(reason: string) {
    for (const [, fn] of this.pending) fn({ result: 'rejected', reason });
    this.pending.clear();
  }

  private handleMessage(raw: string | ArrayBuffer | Blob) {
    if (typeof raw !== 'string') return;
    let msg: Response;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const id = (msg as any).id as string | undefined;
    if (id && this.pending.has(id)) {
      const cb = this.pending.get(id)!;
      this.pending.delete(id);
      cb(msg);
    }
  }

  private send(req: OutboundRequest): Promise<Response> {
    const correlationId = `r${this.nextId++}`;
    (req as any).id = correlationId;
    const payload = JSON.stringify(req);
    return new Promise<Response>((resolve) => {
      this.pending.set(correlationId, resolve);
      this.ensureOpen();
      const sent = this.impl?.send(payload) ?? false;
      if (!sent) this.queue.push(payload);
      setTimeout(() => {
        if (this.pending.has(correlationId)) {
          this.pending.delete(correlationId);
          resolve({ result: 'rejected', reason: 'timeout' });
        }
      }, 15_000);
    });
  }

  async capture(req: CaptureRequest): Promise<Response> {
    return this.send({ kind: 'capture', ...req });
  }

  async getRules(): Promise<CaptureRulesWire | null> {
    const r = await this.send({ kind: 'get_capture_rules' });
    if (r.result === 'capture_rules') return r.rules;
    return null;
  }

  async batch(items: CaptureRequest[]): Promise<Response> {
    // Deliberately no `interactive` / `queue` on the wire: oxdm only
    // skips its triage dialog when the caller both opts out *and*
    // routes every item to a queue. Never sending either keeps a
    // hostile page that drives the extension from bulk-queueing
    // downloads silently. Power-user scripts holding the token can
    // still take the fast path themselves.
    return this.send({ kind: 'batch_capture', items });
  }

  /**
   * oxdm's live queue list, for the non-interactive routing picker.
   * `null` when oxdm is unreachable — callers keep their last choice
   * rather than resetting it.
   *
   * The wire also carries `evaluate_url` (probe a URL for size /
   * filename / resume support). We deliberately don't use it: both of
   * oxdm's dialogs probe every row themselves, so calling it here
   * would be a second round-trip for metadata the user is about to be
   * shown anyway.
   */
  async listQueues(): Promise<QueueSummary[] | null> {
    const r = await this.send({ kind: 'list_queues' });
    if (r.result === 'queues') return r.queues;
    return null;
  }
}

/**
 * The browser collapses every native-messaging discovery failure into
 * a single opaque "Specified native messaging host not found." string.
 * Augment it with the host id, this extension's id, and a checklist of
 * the actual causes so the user has somewhere to start.
 */
interface NativeErrorContext {
  /** Milliseconds between connectNative() returning and onDisconnect firing. */
  elapsedMs: number;
  /** Whether the session ever reached the 'connected' state. */
  wasConnected: boolean;
}

function classifyNativePhase(
  raw: string,
  ctx: NativeErrorContext,
): { phase: string; narrowed: string[] } {
  const notFound = /not found/i.test(raw);
  const exited = /exit/i.test(raw);
  const { elapsedMs, wasConnected } = ctx;

  if (wasConnected) {
    return {
      phase: `runtime (after ${elapsedMs} ms of established session)`,
      narrowed: [
        'The shim was alive and forwarding traffic, then exited. Most likely the oxdm desktop app was closed or its WebSocket bridge crashed.',
        'Start oxdm and the next request will respawn the shim.',
      ],
    };
  }
  if (notFound || elapsedMs < 20) {
    return {
      phase: `discovery (${elapsedMs} ms, process never spawned)`,
      narrowed: [
        'The browser could not locate or load the native-messaging manifest. The shim binary was never executed.',
        'Verify the manifest file exists in this browser\'s NativeMessagingHosts directory and lists this extension in allowed_origins / allowed_extensions.',
      ],
    };
  }
  if (exited && elapsedMs < 250) {
    return {
      phase: `spawn (${elapsedMs} ms, process exited almost immediately)`,
      narrowed: [
        'The shim binary was launched but exited before it could begin forwarding. Likely cause: the "path" in the manifest points at a missing/non-executable binary, or the binary itself rejected its launch arguments.',
        'Confirm the path field of the manifest with: cat ~/.config/<browser>/NativeMessagingHosts/io.github.jd1378.oxdm.host.json',
      ],
    };
  }
  return {
    phase: `bootstrap (${elapsedMs} ms, shim ran briefly then exited before being usable)`,
    narrowed: [
      'The shim spawned and ran long enough to do work, but exited before the session was confirmed.',
      'Common causes: oxdm desktop app is not running (shim cannot reach the loopback WebSocket bridge), or oxdm.db is missing / unreadable / lacks settings.ext_token.',
    ],
  };
}

function buildNativeErrorReason(
  raw: string,
  ctx?: NativeErrorContext,
): string {
  const looksLikeNotFound = /not found/i.test(raw);
  const looksLikeExited = /exit/i.test(raw);
  const extId =
    (typeof browser !== 'undefined' && browser.runtime?.id) || '<unknown>';
  const head = `[${NATIVE_HOST_NAME}] ${raw}`;
  const phaseLines: string[] = [];
  if (ctx) {
    const { phase, narrowed } = classifyNativePhase(raw, ctx);
    phaseLines.push(`Failed in phase: ${phase}`);
    for (const n of narrowed) phaseLines.push(`  → ${n}`);
    phaseLines.push('');
  }
  if (looksLikeExited && !looksLikeNotFound) {
    return [
      head,
      '',
      ...phaseLines,
      'The oxdm-native-host binary launched but exited before staying connected. Common causes:',
      '  1. The oxdm desktop app is not running. The shim exits with code 1 when it cannot reach the WebSocket bridge.',
      '     Fix: start oxdm. The shim will be respawned on the next request.',
      '  2. oxdm.db is missing or unreadable for the user that owns the browser process.',
      '     The shim reads port + token from ~/.local/share/oxdm/oxdm.db (Linux) /',
      '     ~/Library/Application Support/oxdm/oxdm.db (macOS) / %APPDATA%\\oxdm\\oxdm.db (Windows).',
      '     If oxdm runs under a different user, point the shim at the real DB via a --db-path wrapper.',
      '  3. oxdm has never been launched on this machine, so oxdm.db / its settings table does not exist yet.',
      '     The token is auto-generated on first launch; just start the oxdm app once and retry.',
      '  4. The installed oxdm-native-host binary is older than this oxdm app and uses an incompatible wire shape.',
      '     Fix: rebuild + reinstall the host: cargo build --release --bin oxdm-native-host && oxdm/tools/install-native-host.sh ...',
      '  5. On Flatpak/Snap browsers, the shim may run under a sandbox that cannot see oxdm.db on the host.',
      '     Fix: grant read access to the oxdm data dir, or pass --db-path to the binary in the host. Browser stderr typically holds the exact cause but is not exposed to the extension.',
    ].join('\n');
  }
  if (!looksLikeNotFound) {
    if (phaseLines.length === 0) return head;
    return [head, '', ...phaseLines].join('\n');
  }
  return [
    head,
    '',
    ...phaseLines,
    head,
    '',
    'The browser could not launch the oxdm native host. Common causes:',
    `  1. The native-messaging manifest "${NATIVE_HOST_NAME}.json" is missing from this browser's NativeMessagingHosts directory.`,
    `     Fix: run oxdm/tools/install-native-host.sh --chromium-id ${extId} (or --firefox-id <id> for Firefox builds).`,
    '  2. The manifest exists but its "allowed_origins" / "allowed_extensions" does not include this extension.',
    `     This extension's id: ${extId}`,
    '     Re-run the installer with the id above.',
    '  3. The "path" field in the manifest points at a missing or non-executable file.',
    '     Confirm oxdm-native-host is on disk where the manifest says, and is chmod +x.',
    '  4. Manifest file mode does not allow the browser to read it (e.g. dropped into root-owned dir).',
    '     Per-user dirs (~/.config/<browser>/NativeMessagingHosts) avoid this; install as the same user that runs the browser.',
    '  5. On Flatpak/Snap browsers, the sandbox cannot reach the host binary even when the manifest is in place.',
    '     For Flatpak: expose only the host binary, not the full filesystem:',
    '       flatpak override --user --filesystem=/usr/local/bin/oxdm-native-host:ro <flatpak-id>',
    '     Adjust the path to wherever oxdm-native-host actually lives. Avoid --filesystem=host:ro.',
  ].join('\n');
}

export const client = new OxdmClient();
