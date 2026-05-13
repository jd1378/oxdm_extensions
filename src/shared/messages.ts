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

export interface BatchCaptureRequest {
  kind: 'batch_capture';
  id: string;
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
  | BatchCaptureRequest;

export type Response =
  | { result: 'accepted'; job_id: string; id?: string }
  | { result: 'rejected'; reason: string; id?: string };

// --- Internal extension-side messages (runtime.sendMessage) ---

export type RuntimeMsg =
  | { kind: 'get-state' }
  | { kind: 'set-enabled'; enabled: boolean }
  | { kind: 'capture'; req: CaptureRequest }
  | { kind: 'batch'; items: CaptureRequest[] }
  | { kind: 'connection-status' }
  | { kind: 'menu-state'; selection: number; page: number };
