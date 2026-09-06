import { useRef, useState } from "react";
import { ApiError, type Api } from "../lib/api";
import { Button } from "./ui/button";

export function RetryResult({ api, id }: { api: Api; id: string }) {
  const key = useRef<string | null>(null);
  const flight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const retry = async () => {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setError("");
    key.current ??= crypto.randomUUID();
    try {
      await api.retryProcessing("result", id, key.current);
      setDone(true);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status < 500)
        key.current = null;
      setError(
        "The retry could not be confirmed. Try again to recover the same request.",
      );
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="result-retry">
      <Button
        variant="outline"
        disabled={busy || done}
        onClick={() => void retry()}
      >
        {busy ? "Queuing…" : done ? "Retry queued" : "Retry processing"}
      </Button>
      {done ? (
        <p className="muted small" role="status">
          A new attempt is queued. Earlier results and corrections stay
          available. Processing runs while automatic updates are on.
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
