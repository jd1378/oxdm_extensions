// Reconnecting WebSocket client to oxdm. Lives in the background script.
// One socket per browser session; auto-reconnects with backoff.

import type { OutboundRequest, Response, QueueSummary } from './messages';

type Pending = (r: Response) => void;

export type ConnState = 'disconnected' | 'connecting' | 'authed' | 'error';

export class OxdmClient {
  private ws: WebSocket | null = null;
  private state: ConnState = 'disconnected';
  private pending = new Map<string, Pending>();
  private queue: string[] = [];
  private nextId = 1;
  private backoffMs = 1000;
  private port = 27812;
  private token = '';
  private listeners = new Set<(s: ConnState) => void>();

  configure(port: number, token: string) {
    const changed = port !== this.port || token !== this.token;
    this.port = port;
    this.token = token;
    if (changed && this.ws) {
      try {
        this.ws.close();
      } catch {}
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

  ensureOpen() {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
    } catch (e) {
      this.setState('error');
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ token: this.token }));
      this.setState('authed');
      this.backoffMs = 1000;
      for (const m of this.queue) ws.send(m);
      this.queue = [];
    });
    ws.addEventListener('message', (ev) => this.handleMessage(ev.data));
    ws.addEventListener('close', () => {
      this.ws = null;
      this.setState('disconnected');
      this.failAllPending('socket closed');
      this.scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      this.setState('error');
    });
  }

  private scheduleReconnect() {
    setTimeout(() => this.ensureOpen(), this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
  }

  private failAllPending(reason: string) {
    for (const [, fn] of this.pending) {
      fn({ result: 'rejected', reason });
    }
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
      return;
    }
    // No correlation id (v1 untagged capture reply). Drop on the floor —
    // the original send already resolved via a fire-and-forget path.
  }

  private send(req: OutboundRequest, id?: string): Promise<Response> {
    const correlationId = id ?? `r${this.nextId++}`;
    (req as any).id = correlationId;
    const payload = JSON.stringify(req);
    return new Promise<Response>((resolve) => {
      this.pending.set(correlationId, resolve);
      this.ensureOpen();
      if (this.ws && this.ws.readyState === 1 && this.state === 'authed') {
        this.ws.send(payload);
      } else {
        this.queue.push(payload);
      }
      setTimeout(() => {
        if (this.pending.has(correlationId)) {
          this.pending.delete(correlationId);
          resolve({ result: 'rejected', reason: 'timeout' });
        }
      }, 15_000);
    });
  }

  async capture(req: import('./messages').CaptureRequest): Promise<Response> {
    return this.send({ kind: 'capture', ...req });
  }

  async listQueues(): Promise<QueueSummary[]> {
    const r = await this.send({ kind: 'list_queues', id: '' });
    if (r.result === 'queues') return r.queues;
    return [];
  }

  async evaluate(
    url: string,
    extras?: { referrer?: string; cookies?: string; user_agent?: string },
  ): Promise<Extract<Response, { result: 'evaluated' }>> {
    const r = await this.send({
      kind: 'evaluate_url',
      id: '',
      url,
      ...(extras ?? {}),
    });
    if (r.result === 'evaluated') return r;
    return { result: 'evaluated', id: '', url, error: (r as any).reason ?? 'unknown' };
  }

  async batch(items: import('./messages').CaptureRequest[]): Promise<Response> {
    return this.send({ kind: 'batch_capture', id: '', items });
  }
}

export const client = new OxdmClient();
