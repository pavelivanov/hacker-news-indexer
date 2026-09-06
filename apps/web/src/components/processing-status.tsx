import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { ApiError, type Api, type ProcessingStatus } from "../lib/api";
import { Button } from "./ui/button";
import { ProcessingSettings } from "./processing-settings";

export const processingError = (code: string | null) => {
  if (code === "CLASSIFIER_AUTH")
    return "The classifier credential was rejected. Update the server credential and restart the workspace.";
  if (code === "CLASSIFIER_CONFIG")
    return "Classifier settings need attention on the server.";
  if (code === "SOURCE_CONNECTION_FAILED")
    return "Could not connect to the comment source. Automatic updates will try again.";
  if (code === "SOURCE_UNAVAILABLE")
    return "The source comment is unavailable.";
  if (code === "DAILY_REQUEST_LIMIT")
    return "The daily request limit was reached. Processing resumes after the UTC reset.";
  if (code === "CLASSIFIER_RATE_LIMIT")
    return "The provider asked us to wait before trying again.";
  if (code === "CLASSIFIER_TIMEOUT")
    return "The classifier took too long to respond.";
  if (code === "PROCESSING_MODEL_CHANGED")
    return "The configured model changed. Retry to use the current model.";
  return code ? "Processing did not complete. You can retry this item." : "";
};
const time = (value: string | null) =>
  value ? new Date(value).toLocaleString() : "Not yet";
export function ProcessingStatusPanel({
  api,
  onNewResults,
}: {
  api: Api;
  onNewResults: () => void;
}) {
  const [status, setStatus] = useState<ProcessingStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState<{ id: string; key: string } | null>(null);
  const flight = useRef(false);
  const newest = useRef<string | null | undefined>(undefined);
  const accept = useCallback(
    (next: ProcessingStatus) => {
      if (
        newest.current !== undefined &&
        newest.current !== next.last_result_at
      )
        onNewResults();
      newest.current = next.last_result_at;
      setStatus((previous) =>
        previous && previous.settings_version > next.settings_version
          ? {
              ...next,
              interval_seconds: previous.interval_seconds,
              daily_request_limit: previous.daily_request_limit,
              settings_version: previous.settings_version,
              next_sync_at: previous.next_sync_at,
            }
          : next,
      );
    },
    [onNewResults],
  );
  useEffect(() => {
    const controller = new AbortController();
    let polling = false;
    const poll = async () => {
      if (polling || document.hidden) return;
      polling = true;
      try {
        const next = await api.processing(
          AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        );
        if (!controller.signal.aborted) {
          accept(next);
          setError((previous) =>
            previous ===
            "Processing status is unavailable. Your saved results remain available."
              ? ""
              : previous,
          );
        }
      } catch {
        if (!controller.signal.aborted)
          setError(
            "Processing status is unavailable. Your saved results remain available.",
          );
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [api, accept]);
  const control = async (action: "sync" | "pause" | "resume") => {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setError("");
    try {
      await api.controlProcessing(action);
      accept(await api.processing());
      setNotice(
        action === "pause"
          ? "Updates paused. The current item can finish."
          : action === "resume"
            ? "Automatic updates resumed."
            : "Sync requested. New results will appear when processing finishes.",
      );
    } catch {
      setError("Could not update processing. Try the same action again.");
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  const retryJob = async (id: string) => {
    if (flight.current) return;
    const command = retry ?? { id, key: crypto.randomUUID() };
    flight.current = true;
    setBusy(true);
    setRetry(command);
    setError("");
    try {
      await api.retryProcessing("job", command.id, command.key);
      setRetry(null);
      accept(await api.processing());
      setNotice(
        "Retry queued. Earlier predictions and corrections are preserved.",
      );
    } catch (failure) {
      if (failure instanceof ApiError && failure.status < 500) {
        setRetry(null);
        setError(
          "This item has already changed. Refresh processing status before retrying.",
        );
      } else
        setError(
          "The retry response was interrupted. Retry the same request to recover it safely.",
        );
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  const limited =
    !!status && status.requests_today >= status.daily_request_limit;
  const title = !status
    ? "Checking updates…"
    : !status.online
      ? "Automatic updates offline"
      : !status.enabled
        ? "Automatic updates paused"
        : limited
          ? "Daily request limit reached"
          : status.error_code
            ? "Updates need attention"
            : status.processing > 0
              ? "Processing new comments"
              : status.pending > 0
                ? "Comments queued"
                : "Automatic updates on";
  return (
    <section className="processing-status" aria-label="Feed processing">
      <div className="processing-heading">
        <div>
          <p className="processing-title">{title}</p>
          <p className="muted small">
            Last checked: {time(status?.last_checked_at ?? null)}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={
            !status?.online || !status.enabled || busy || status.sync_requested
          }
          onClick={() => void control("sync")}
        >
          <RefreshCw data-icon="inline-start" aria-hidden="true" />
          Sync now
        </Button>
      </div>
      {status ? (
        <details>
          <summary>
            Processing details
            {status.failed ? ` · ${status.failed} failed` : ""}
          </summary>
          <p>
            {status.pending} queued · {status.processing} processing ·{" "}
            {status.failed} failed
          </p>
          <p className="muted small">
            Checks every {Math.round(status.interval_seconds / 60)} minutes · up
            to {status.batch_size} selections per sync.
            <br />
            {status.requests_today} of {status.daily_request_limit} classifier
            requests used today. Resets at {time(status.budget_resets_at)}.
          </p>
          <p className="muted small">
            Latest result: {time(status.last_result_at)}
          </p>
          {!status.online ? (
            <p className="muted small">
              Start the local workspace to receive fresh results.
            </p>
          ) : null}
          {status.error_code ? (
            <p role="status">{processingError(status.error_code)}</p>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            disabled={!status.configured || busy}
            onClick={() => void control(status.enabled ? "pause" : "resume")}
          >
            {status.enabled ? "Pause updates" : "Resume updates"}
          </Button>
          <ProcessingSettings
            api={api}
            status={status}
            disabled={busy}
            onSaved={accept}
          />
          {status.failures.length ? (
            <ul className="processing-failures">
              {status.failures.map((item) => (
                <li key={item.id}>
                  <div>
                    <strong>
                      {item.comment_id
                        ? `Comment #${item.comment_id}`
                        : "Source sync"}
                    </strong>
                    <p>{processingError(item.error_code)}</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !!retry}
                    onClick={() => void retryJob(item.id)}
                  >
                    Retry{item.comment_id ? ` #${item.comment_id}` : " sync"}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {status.failed > status.failures.length ? (
            <p className="muted small">
              Showing the {status.failures.length} most recent failures. Retry
              these to reveal older items.
            </p>
          ) : null}
        </details>
      ) : null}
      {error ? (
        <p className="processing-message" role="alert">
          {error}
        </p>
      ) : null}
      {retry ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void retryJob(retry.id)}
        >
          Retry same request
        </Button>
      ) : null}
      {notice ? (
        <p className="muted small" role="status">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
