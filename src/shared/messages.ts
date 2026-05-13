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
}

export interface ListQueuesRequest {
  kind: 'list_queues';
  id: string;
}

export interface EvaluateUrlRequest {
  kind: 'evaluate_url';
  id: string;
  url: string;
  referrer?: string;
  cookies?: string;
  user_agent?: string;
  headers?: Record<string, string>;
}

export interface BatchCaptureRequest {
  kind: 'batch_capture';
  id: string;
  items: CaptureRequest[];
}

export type OutboundRequest =
  | ({ kind?: 'capture' } & CaptureRequest)
  | ListQueuesRequest
  | EvaluateUrlRequest
  | BatchCaptureRequest;

export interface QueueSummary {
  id: string;
  name: string;
}

export type Response =
  | { result: 'accepted'; job_id: string; id?: string }
  | { result: 'rejected'; reason: string; id?: string }
  | { result: 'queues'; id: string; queues: QueueSummary[] }
  | {
      result: 'evaluated';
      id: string;
      url: string;
      filename?: string;
      size?: number;
      mime_type?: string;
      supports_resume?: boolean;
      etag?: string;
      error?: string;
    };

// --- Internal extension-side messages (runtime.sendMessage) ---

export type RuntimeMsg =
  | { kind: 'get-state' }
  | { kind: 'set-enabled'; enabled: boolean }
  | { kind: 'capture'; req: CaptureRequest }
  | { kind: 'batch-prepare'; items: CaptureRequest[] }
  | { kind: 'batch-send'; items: CaptureRequest[] }
  | { kind: 'evaluate'; url: string; referrer?: string }
  | { kind: 'list-queues' }
  | { kind: 'connection-status' };
