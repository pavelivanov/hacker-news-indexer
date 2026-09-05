export interface FeedProcessingStatus {
  configured: boolean;
  enabled: boolean;
  online: boolean;
  source: string;
  last_checked_at: string | null;
  last_result_at: string | null;
  next_sync_at: string | null;
  sync_requested: boolean;
  error_code: string | null;
  interval_seconds: number;
  batch_size: number;
  daily_request_limit: number;
  requests_today: number;
  budget_resets_at: string;
  pending: number;
  processing: number;
  failed: number;
  failures: Array<{
    id: string;
    stage: string;
    comment_id: number | null;
    error_code: string | null;
    attempts: number;
  }>;
}
export interface FeedProcessingRepository {
  status(): Promise<FeedProcessingStatus>;
  control(action: "sync" | "pause" | "resume"): Promise<void>;
  retry(
    kind: "job" | "result",
    id: string,
    commandKey: string,
  ): Promise<{ job_id: string; replayed: boolean }>;
}
