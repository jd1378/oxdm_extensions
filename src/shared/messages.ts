// Wire types matching oxdm's IPC contract.
// Bare CaptureRequest is the v1 untagged shape. New requests carry `kind`.

export interface CaptureRequest {
  url: string;
  filename?: string;
  referrer?: string;
  cookies?: string;
  user_agent?: string;
  headers?: Record<string, string>;
  size?: number;
  mime_type?: string;
  interactive?: boolean;
  /** Power-user override — target queue by UUID. Falls back to Main on unknown id. */
  queue?: string;
  /** Power-user override — target queue by case-insensitive name. Ignored when `queue` is set. */
  queue_name?: string;
  /** If true, oxdm also starts the receiving queue's scheduler after adding. */
  auto_start_queue?: boolean;
}

export interface GetCaptureRulesRequest {
  kind: 'get_capture_rules';
  id?: string;
}

export interface ListQueuesRequest {
  kind: 'list_queues';
  id?: string;
}

// The wire also defines `evaluate_url` (probe a URL for size /
// filename / resume support). It is intentionally absent here: both
// of oxdm's dialogs probe their own rows, so the extension has no
// metadata to gather that oxdm isn't about to gather itself.

export interface QueueSummary {
  id: string;
  name: string;
}

export interface CaptureRulesWire {
  min_size?: number;
  skip_domains?: string[];
  skip_extensions?: string[];
  skip_mime_prefixes?: string[];
  allow_extensions?: string[];
  allow_mime_prefixes?: string[];
}

export interface BatchCaptureRequest {
  kind: 'batch_capture';
  /** Correlation id; injected by the client. */
  id?: string;
  /**
   * Server default is `true` (open oxdm's triage dialog). The
   * no-dialog fast path only fires on `false` *and* every item having
   * a resolvable queue — which this extension never sets on batches,
   * so a hostile page driving us cannot suppress triage.
   */
  interactive?: boolean;
  /** Default queue for items that don't carry their own. */
  queue?: string;
  /** Default queue name (case-insensitive). Ignored when `queue` is set. */
  queue_name?: string;
  /** If true, the resolved queue is also started after all items are added. */
  auto_start_queue?: boolean;
  items: CaptureRequest[];
}

export type OutboundRequest =
  | ({ kind?: 'capture' } & CaptureRequest)
  | BatchCaptureRequest
  | GetCaptureRulesRequest
  | ListQueuesRequest;

export type Response =
  | { result: 'accepted'; job_id: string; id?: string }
  | { result: 'rejected'; reason: string; id?: string }
  | { result: 'capture_rules'; id?: string; rules: CaptureRulesWire }
  | { result: 'queues'; id?: string; queues: QueueSummary[] }
  | { result: 'batch_result'; id?: string; accepted: string[]; rejected: string[] };

// --- Internal extension-side messages (runtime.sendMessage) ---

export type RuntimeMsg =
  | { kind: 'capture'; req: CaptureRequest }
  | { kind: 'batch'; items: CaptureRequest[] }
  | { kind: 'connection-status' }
  | { kind: 'list-queues' }
  | { kind: 'menu-state'; selection: number; page: number }
  | { kind: 'get-logs' }
  | { kind: 'clear-logs' };
