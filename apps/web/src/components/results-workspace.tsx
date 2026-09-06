import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowUpRight, LockKeyhole, RefreshCw } from "lucide-react";
import {
  type Api,
  type ResultsFilter,
  type ResultsPage,
  errorMessage,
} from "../lib/api";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Choice } from "./form-fields";
import { Alert, AlertTitle, AlertDescription } from "./ui/alert";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "./ui/empty";
import { Skeleton } from "./ui/skeleton";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "./ui/alert-dialog";
import {
  ClassifierResultDetail,
  resultCategoryLabel,
} from "./classifier-result-detail";
import { cn } from "../lib/utils";
import { ProcessingStatusPanel } from "./processing-status";

const filters: ResultsFilter[] = [
  "all",
  "discovery",
  "expert_note",
  "skipped",
  "uncertain",
  "corrected",
];
const names: Record<ResultsFilter, string> = {
  all: "All results",
  discovery: "Discoveries",
  expert_note: "Expert notes",
  skipped: "Skipped comments",
  uncertain: "Uncertain or failed",
  corrected: "Your corrections",
};
const locationState = () => {
  const query = new URLSearchParams(location.search);
  const filter = query.get("filter") as ResultsFilter;
  const id = query.get("result");
  return {
    filter: filters.includes(filter) ? filter : ("all" as ResultsFilter),
    id: id && /^[a-f0-9-]{36}$/i.test(id) ? id : null,
  };
};
export function ResultsWorkspace({
  api,
  onLock,
  onManual,
}: {
  api: Api;
  onLock: () => void;
  onManual: () => void;
}) {
  const [filter, setFilter] = useState<ResultsFilter>(
    () => locationState().filter,
  );
  const [selected, setSelected] = useState<string | null>(
    () => locationState().id,
  );
  const [page, setPage] = useState<ResultsPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [leave, setLeave] = useState<(() => void) | null>(null);
  const [notice, setNotice] = useState("");
  const [newResults, setNewResults] = useState(false);
  const onNewResults = useCallback(() => setNewResults(true), []);
  const onState = useCallback((changed: boolean, inFlight: boolean) => {
    setDirty(changed);
    setBusy(inFlight);
  }, []);
  const navigate = (action: () => void) => {
    if (busy) return;
    if (dirty) setLeave(() => action);
    else action();
  };
  const locationTo = (nextFilter: ResultsFilter, id: string | null) => {
    setFilter(nextFilter);
    setSelected(id);
    setDirty(false);
    const query = new URLSearchParams({ view: "results", filter: nextFilter });
    if (id) query.set("result", id);
    history.replaceState(null, "", `?${query}`);
  };
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirty || busy) event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty, busy]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setPage(null);
    void api
      .results(filter, null, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setPage(value);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, filter, revision]);
  const more = async () => {
    if (!page?.next_cursor || loading) return;
    setLoading(true);
    try {
      const next = await api.results(filter, page.next_cursor);
      setPage((previous) => ({
        ...next,
        items: [...(previous?.items ?? []), ...next.items],
      }));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to results
      </a>
      <header className="app-header">
        <a
          className="brand"
          href="?view=results"
          onClick={(event) => {
            event.preventDefault();
            navigate(() => locationTo("all", null));
          }}
        >
          <span className="brand-mark">HN</span>
          <span>Knowledge</span>
        </a>
        <nav aria-label="Main navigation">
          <a
            href="?view=results"
            aria-current="page"
            onClick={(event) => {
              event.preventDefault();
              navigate(() => locationTo(filter, null));
            }}
          >
            Classifier results
          </a>
          <Button variant="ghost" onClick={() => navigate(onManual)}>
            Manual workspace
          </Button>
        </nav>
        <div className="header-tools">
          <span className="local-indicator">Local workspace</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => navigate(onLock)}
          >
            <LockKeyhole data-icon="inline-start" aria-hidden="true" />
            Lock
          </Button>
        </div>
      </header>
      <main
        id="main"
        className={cn("results-layout", selected && "result-selected")}
      >
        <section
          className="results-list panel-scroll"
          aria-label="Classifier results"
        >
          <div className="results-heading">
            <div>
              <p className="eyebrow">Read now · correct anytime</p>
              <h1>Classifier results</h1>
              <p className="muted">
                Discoveries, technical notes, and what the classifier skipped.
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh results"
              disabled={loading || busy}
              onClick={() => setRevision((value) => value + 1)}
            >
              <RefreshCw data-icon="inline-start" aria-hidden="true" />
            </Button>
          </div>
          <Choice
            label="Show results"
            value={filter}
            values={filters}
            optionLabel={(value) => names[value]}
            disabled={loading || busy}
            onChange={(next) => navigate(() => locationTo(next, null))}
          />
          <ProcessingStatusPanel api={api} onNewResults={onNewResults} />
          {newResults ? (
            <Button
              variant="outline"
              disabled={loading || busy}
              onClick={() => {
                setNewResults(false);
                setRevision((value) => value + 1);
              }}
            >
              Show new results
            </Button>
          ) : null}
          {notice ? (
            <Alert>
              <AlertTitle>{notice}</AlertTitle>
              <AlertDescription>
                Feedback is saved for later improvements. The model has not been
                retrained.
              </AlertDescription>
            </Alert>
          ) : null}
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Results unavailable</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {loading && !page ? (
            <div role="status" className="results-loading">
              Loading results…
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : null}
          {page && !page.items.length ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>
                  {filter === "all"
                    ? "No classifier results yet"
                    : "No results in this view"}
                </EmptyTitle>
                <EmptyDescription>
                  {filter === "all"
                    ? "Once the captured comments are processed, their results appear here automatically. No approval is needed."
                    : "Try All results to keep browsing."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
          <ol className="classifier-result-list">
            {page?.items.map((item) => (
              <li key={item.id}>
                <a
                  href={`?view=results&filter=${filter}&result=${item.id}`}
                  aria-current={selected === item.id ? "true" : undefined}
                  onClick={(event) => {
                    if (
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    )
                      return;
                    event.preventDefault();
                    navigate(() => locationTo(filter, item.id));
                  }}
                >
                  <div className="result-meta">
                    <Badge variant="outline">
                      {resultCategoryLabel(item.category)}
                    </Badge>
                    <span>
                      {item.feedback_version
                        ? "Corrected by you"
                        : "AI generated"}
                    </span>
                    <span>HN #{item.comment_id}</span>
                  </div>
                  <h2>
                    {item.title}
                    <ArrowUpRight aria-hidden="true" size={18} />
                  </h2>
                  <p className="result-summary">{item.summary}</p>
                  <span className="result-action">Read source & details</span>
                </a>
              </li>
            ))}
          </ol>
          {page?.next_cursor ? (
            <Button variant="outline" disabled={loading} onClick={more}>
              {loading ? "Loading…" : "Load more results"}
            </Button>
          ) : null}
        </section>
        {selected ? (
          <section
            className="result-inspector panel-scroll"
            aria-label="Result details"
          >
            <Button
              variant="ghost"
              onClick={() => navigate(() => locationTo(filter, null))}
              disabled={busy}
            >
              <ArrowLeft data-icon="inline-start" aria-hidden="true" />
              Back to results
            </Button>
            <ClassifierResultDetail
              key={selected}
              id={selected}
              api={api}
              onState={onState}
              onSaved={() => {
                setDirty(false);
                setNotice("Correction saved");
                setRevision((value) => value + 1);
              }}
            />
          </section>
        ) : null}
      </main>
      <AlertDialog
        open={leave !== null}
        onOpenChange={(open) => {
          if (!open) setLeave(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave your correction?</AlertDialogTitle>
            <AlertDialogDescription>
              Your unsaved text will be discarded. Saved feedback remains
              available.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const action = leave;
                setLeave(null);
                setDirty(false);
                action?.();
              }}
            >
              Discard and leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
