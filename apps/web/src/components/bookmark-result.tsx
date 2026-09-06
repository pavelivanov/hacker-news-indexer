import { useRef, useState } from "react";
import { Bookmark, BookmarkCheck } from "lucide-react";
import type { ResultBookmarkV1 } from "@hn-knowledge/contracts";
import { ApiError, type Api, type ResultBookmarkState } from "../lib/api";
import { Button } from "./ui/button";

export function BookmarkResult({
  api,
  id,
  title,
  state,
  onChange,
}: {
  api: Api;
  id: string;
  title: string;
  state: ResultBookmarkState;
  onChange: (state: ResultBookmarkState) => void;
}) {
  const [pending, setPending] = useState<ResultBookmarkV1 | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const flight = useRef(false);
  const toggle = async () => {
    if (flight.current) return;
    const command = pending ?? {
      bookmarked: !state.bookmarked,
      expected_version: state.bookmark_version,
      command_key: crypto.randomUUID(),
    };
    flight.current = true;
    setBusy(true);
    setPending(command);
    setError("");
    setNotice("");
    try {
      await api.bookmarkResult(id, command);
      const current = await api.result(id);
      onChange(current);
      setNotice(current.bookmarked ? "Result saved." : "Bookmark removed.");
      setPending(null);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status < 500) {
        setPending(null);
        if (failure.status === 409) {
          try {
            onChange(await api.result(id));
            setError(
              "This bookmark changed in another tab. Its current state is shown; try again to change it.",
            );
          } catch {
            setError(
              "Could not refresh the bookmark. Reload this result before changing it.",
            );
          }
        } else
          setError(
            "The bookmark could not be changed. Refresh this result and try again.",
          );
      } else
        setError(
          "The response was interrupted. Retry the bookmark request to recover it safely.",
        );
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  const Icon = state.bookmarked ? BookmarkCheck : Bookmark;
  return (
    <div className="bookmark-control">
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        aria-pressed={state.bookmarked}
        aria-label={`${pending && !busy ? "Retry bookmark" : state.bookmarked ? "Remove bookmark" : "Save result"}: ${title}`}
        onClick={() => void toggle()}
      >
        <Icon data-icon="inline-start" aria-hidden="true" />
        {busy
          ? "Saving…"
          : pending
            ? "Retry bookmark"
            : state.bookmarked
              ? "Saved"
              : "Save"}
      </Button>
      {error ? (
        <p className="small" role="alert">
          {error}
        </p>
      ) : null}
      <span className="sr-only" role="status">
        {notice}
      </span>
    </div>
  );
}
