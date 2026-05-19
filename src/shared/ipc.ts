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

export type ConnState = 'disconnected' | 'connecting' | 'authed' | 'error';

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
  private autoFellBackToWs = false;
  /** Set false by `stop()` to suppress reconnect loops while disabled. */
  private wantConnection = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  configure(opts: {
    port: number;
    token: string;
    transport: Transport;
  }) {
    const changed =
      opts.port !== this.port ||
      opts.token !== this.token ||
      opts.transport !== this.transportPref;
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

  onState(cb: (s: ConnState) => void) {
    this.listeners.add(cb);
    cb(this.state);
    return () => this.listeners.delete(cb);
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
      this.impl = null;
      this.activeTransport = null;
      this.setState('disconnected');
      this.failAllPending(err?.message ?? 'native host disconnected');
      // First-time failure on 'auto' → fall back to WS on next ensureOpen.
      if (this.transportPref === 'auto' && this.state !== 'authed') {
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

    // Native host does its own auth (reads oxdm.db). We're "authed"
    // the moment connectNative succeeds without onDisconnect firing
    // on the same tick. Flush queue + mark authed; failures will
    // surface via onDisconnect.
    queueMicrotask(() => {
      if (this.impl === null) return;
      this.setState('authed');
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
    } catch {
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
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ token: this.token }));
      this.setState('authed');
      this.backoffMs = 1000;
      for (const m of this.queue) ws.send(m);
      this.queue = [];
    });
    ws.addEventListener('message', (ev) => this.handleMessage(ev.data));
    ws.addEventListener('close', () => {
      this.impl = null;
      this.activeTransport = null;
      this.setState('disconnected');
      this.failAllPending('socket closed');
      this.scheduleReconnect();
    });
    ws.addEventListener('error', () => this.setState('error'));
  }

  private scheduleReconnect() {
    if (!this.wantConnection) return;
    if (this.reconnectTimer) return;
    const delay = this.backoffMs;
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
