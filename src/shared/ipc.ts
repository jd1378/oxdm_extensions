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
} from './messages';
import { NATIVE_HOST_NAME, type Transport } from './state';

type Pending = (r: Response) => void;

export type ConnState =
  | 'disconnected'
  | 'connecting'
  | 'reconnecting'
  | 'connected'
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
  /** Set false by `stop()` to suppress reconnect loops while disabled. */
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
    const transportSatisfied =
      this.activeTransport != null &&
      (opts.transport === 'auto' ||
        opts.transport === this.activeTransport);
    const changed =
      opts.port !== this.port ||
      opts.token !== this.token ||
      (opts.transport !== this.transportPref && !transportSatisfied);
    this.port = opts.port;
    this.token = opts.token;
    this.transportPref = opts.transport;
    if (changed) {
      this.autoFellBackToWs = false;
      if (this.impl) {
        try {
          this.impl.close();
        } catch {}
        this.impl = null;
      }
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

  /** Stop reconnecting and close any open transport. Idempotent. */
  stop() {
    this.wantConnection = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.impl) {
      try {
        this.impl.close();
      } catch {}
      this.impl = null;
    }
    this.activeTransport = null;
    this.setState('disconnected');
    this.failAllPending('client stopped');
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
      this.emitError('native host unreachable (binary missing or manifest not installed)');
      this.setState('error');
      this.scheduleReconnect();
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
    port.onMessage.addListener((msg: any) => {
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
      const reason = err?.message ?? 'native host disconnected';
      const wasConnected = this.state === 'connected';
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

    // Native host does its own auth (reads oxdm.db). We're connected
    // the moment connectNative succeeds without onDisconnect firing
    // on the same tick. Flush queue + mark connected; failures will
    // surface via onDisconnect.
    queueMicrotask(() => {
      if (this.impl === null) return;
      this.setState('connected');
      this.backoffMs = 1000;
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
    // Heuristic auth-rejection detection: the wire has no positive
    // ack for the auth frame — oxdm just closes the socket on bad
    // token. So we flag "awaiting auth" between sending the frame
    // and either a server reply landing or a short grace period
    // passing. A close during that window is almost certainly a
    // token rejection, not a transport drop.
    let awaitingAuth = false;
    const clearAwaiting = () => {
      awaitingAuth = false;
    };
    ws.addEventListener('open', () => {
      awaitingAuth = true;
      ws.send(JSON.stringify({ token: this.token }));
      this.setState('connected');
      this.backoffMs = 1000;
      // First reply from the server = auth implicitly accepted.
      // Otherwise auto-clear after a grace so a quiet but valid
      // session doesn't stay flagged forever.
      setTimeout(clearAwaiting, 1500);
      for (const m of this.queue) ws.send(m);
      this.queue = [];
    });
    ws.addEventListener('message', (ev) => {
      clearAwaiting();
      this.handleMessage(ev.data);
    });
    ws.addEventListener('close', (ev) => {
      // If close fires while we're still waiting for the first
      // server-originated reply, attribute it to auth rejection.
      // Otherwise surface the close code verbatim.
      const reason = awaitingAuth
        ? 'token rejected by oxdm — paste a fresh pairing code from oxdm Settings'
        : ev.reason ||
          `socket closed (code ${ev.code}${ev.wasClean ? '' : ', abnormal'})`;
      this.impl = null;
      this.emitError(reason);
      this.activeTransport = null;
      this.setState('disconnected');
      this.failAllPending(reason);
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
    // oxdm always opens the triage dialog for batches now; the
    // `interactive` field is server-ignored. Kept out of the wire to
    // shrink the shape.
    return this.send({ kind: 'batch_capture', items });
  }
}

export const client = new OxdmClient();
