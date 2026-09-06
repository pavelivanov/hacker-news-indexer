import { useCallback, useEffect, useState } from "react";
import {
  Inbox as InboxIcon,
  LockKeyhole,
  RefreshCw,
  BookOpen,
} from "lucide-react";
import {
  errorMessage,
  type Api,
  type FeedKind,
  type Inbox,
  type InboxState,
} from "../lib/api";
import { label } from "../lib/draft";
import { cn } from "../lib/utils";
import { ReviewEditor } from "./review-editor";
import { Feed } from "./feed";
import { ResultsWorkspace } from "./results-workspace";
import { Choice } from "./form-fields";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Alert, AlertTitle, AlertDescription } from "./ui/alert";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "./ui/empty";
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

type View = "inbox" | FeedKind;
const readLocation = () => {
  const query = new URLSearchParams(location.search);
  const view = query.get("view");
  const comment = Number(query.get("comment"));
  return {
    view:
      view === "discovery" || view === "expert_note" ? view : ("inbox" as View),
    comment: Number.isSafeInteger(comment) && comment > 0 ? comment : null,
  };
};

export function Workspace({ api, onLock }: { api: Api; onLock: () => void }) {
  const [manual, setManual] = useState(() =>
    ["inbox", "discovery", "expert_note"].includes(
      new URLSearchParams(location.search).get("view") ?? "",
    ),
  );
  return manual ? (
    <ManualWorkspace
      api={api}
      onLock={onLock}
      onResults={() => {
        history.replaceState(null, "", "?view=results");
        setManual(false);
      }}
    />
  ) : (
    <ResultsWorkspace
      api={api}
      onLock={onLock}
      onManual={() => {
        history.replaceState(null, "", "?view=inbox");
        setManual(true);
      }}
    />
  );
}

function ManualWorkspace({
  api,
  onLock,
  onResults,
}: {
  api: Api;
  onLock: () => void;
  onResults: () => void;
}) {
  const [view, setView] = useState<View>(() => readLocation().view);
  const [selected, setSelected] = useState<number | null>(
    () => readLocation().comment,
  );
  const [filter, setFilter] = useState<InboxState>("unreviewed");
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [refresh, setRefresh] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [leave, setLeave] = useState<(() => void) | null>(null);
  const [notice, setNotice] = useState("");
  const onState = useCallback((hasChanges: boolean, inFlight: boolean) => {
    setDirty(hasChanges);
    setBusy(inFlight);
  }, []);
  const navigate = (action: () => void) => {
    if (busy) return;
    if (dirty) setLeave(() => action);
    else action();
  };
  const switchView = (next: View, id: number | null = null) => {
    setView(next);
    setSelected(id);
    const query = new URLSearchParams({ view: next });
    if (id) query.set("comment", String(id));
    history.replaceState(null, "", `?${query.toString()}`);
  };
  useEffect(() => {
    const listener = (event: BeforeUnloadEvent) => {
      if (dirty || busy) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", listener);
    return () => window.removeEventListener("beforeunload", listener);
  }, [dirty, busy]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setInbox(null);
    void api
      .inbox(filter, null, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setInbox(result);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, filter, refresh]);
  const nextPage = async () => {
    if (!inbox?.next_cursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.inbox(filter, inbox.next_cursor);
      setInbox((previous) => ({
        ...result,
        items: [...(previous?.items ?? []), ...result.items],
      }));
    } catch (failure) {
      setError(failure);
    } finally {
      setLoading(false);
    }
  };
  const published = (
    kind: FeedKind | "rejected",
    id: number,
    warnings: readonly string[],
  ) => {
    setDirty(false);
    setRefresh((n) => n + 1);
    setNotice(
      kind === "rejected"
        ? "Comment rejected. Your reason has been recorded."
        : warnings.length
          ? `Decision approved. Follow-up review: ${warnings.map(label).join(", ")}.`
          : "Decision approved. Showing the published content from the reader.",
    );
    switchView(
      kind === "rejected" ? "inbox" : kind,
      kind === "rejected" ? null : id,
    );
  };
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to workspace
      </a>
      <header className="app-header">
        <a
          className="brand"
          href="?view=inbox"
          onClick={(event) => {
            event.preventDefault();
            navigate(() => switchView("inbox"));
          }}
        >
          <span className="brand-mark">HN</span>
          <span>Knowledge</span>
        </a>
        <nav aria-label="Main navigation">
          <Button variant="ghost" onClick={() => navigate(onResults)}>
            Classifier results
          </Button>
          {(
            [
              ["inbox", "Review inbox"],
              ["discovery", "Discoveries"],
              ["expert_note", "Expert notes"],
            ] as const
          ).map(([next, title]) => (
            <a
              key={next}
              href={`?view=${next}`}
              aria-current={view === next ? "page" : undefined}
              onClick={(event) => {
                if (
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                event.preventDefault();
                navigate(() => switchView(next));
              }}
            >
              {title}
            </a>
          ))}
        </nav>
        <div className="header-tools">
          <span className="local-indicator">Local workspace</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(onLock)}
            disabled={busy}
          >
            <LockKeyhole data-icon="inline-start" aria-hidden="true" />
            Lock
          </Button>
        </div>
      </header>
      {notice ? (
        <div className="workspace-notice" role="status">
          {notice}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setNotice("")}
            aria-label="Dismiss update"
          >
            Dismiss
          </Button>
        </div>
      ) : null}
      <main
        id="main"
        className={cn(
          "workspace",
          view === "inbox" && selected !== null && "has-selection",
        )}
      >
        {view === "inbox" ? (
          <>
            <aside
              className="inbox-pane panel-scroll"
              aria-label="Review inbox"
            >
              <div className="inbox-heading">
                <div>
                  <p className="eyebrow">Captured comments</p>
                  <h1>Review inbox</h1>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Refresh inbox"
                  disabled={loading || busy}
                  onClick={() => setRefresh((n) => n + 1)}
                >
                  <RefreshCw aria-hidden="true" data-icon="inline-start" />
                </Button>
              </div>
              <Choice
                label="Inbox filter"
                disabled={loading || busy}
                value={filter}
                values={["unreviewed", "draft", "approved", "rejected", "all"]}
                onChange={(next) =>
                  navigate(() => {
                    setFilter(next);
                    switchView("inbox");
                  })
                }
              />
              {error ? (
                <Alert>
                  <AlertTitle>Inbox unavailable</AlertTitle>
                  <AlertDescription>{errorMessage(error)}</AlertDescription>
                  <Button
                    variant="outline"
                    onClick={() => setRefresh((n) => n + 1)}
                  >
                    Retry inbox
                  </Button>
                </Alert>
              ) : null}
              {loading && !inbox ? (
                <div className="inbox-loading" role="status">
                  <p>Loading comments…</p>
                  <Skeleton className="h-24 w-full" />
                  <Skeleton className="h-24 w-full" />
                </div>
              ) : null}
              {inbox && !inbox.items.length ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <InboxIcon aria-hidden="true" />
                    </EmptyMedia>
                    <EmptyTitle>No comments in this view</EmptyTitle>
                    <EmptyDescription>
                      Try another filter to find saved or reviewed comments.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : null}
              <ol className="inbox-list">
                {inbox?.items.map((item) => (
                  <li key={item.comment_id}>
                    <a
                      href={`?view=inbox&comment=${item.comment_id}`}
                      aria-current={
                        selected === item.comment_id ? "true" : undefined
                      }
                      onClick={(event) => {
                        if (
                          event.metaKey ||
                          event.ctrlKey ||
                          event.shiftKey ||
                          event.altKey
                        )
                          return;
                        event.preventDefault();
                        navigate(() => {
                          setNotice("");
                          switchView("inbox", item.comment_id);
                        });
                      }}
                    >
                      <span className="inbox-meta">
                        HN #{item.comment_id}
                        <span>{label(item.state)}</span>
                      </span>
                      <p>{item.excerpt || "No source text available"}</p>
                      {!item.available ? (
                        <Badge variant="outline">Source unavailable</Badge>
                      ) : null}
                    </a>
                  </li>
                ))}
              </ol>
              {inbox?.next_cursor ? (
                <Button
                  className="w-full"
                  variant="outline"
                  disabled={loading}
                  onClick={nextPage}
                >
                  {loading ? "Loading…" : "Load more comments"}
                </Button>
              ) : null}
              <p className="inbox-footnote">
                Existing sources. Every decision is yours.
              </p>
            </aside>
            {selected ? (
              <ReviewEditor
                key={selected}
                id={selected}
                api={api}
                onState={onState}
                onPublished={published}
                onBack={() => navigate(() => switchView("inbox"))}
              />
            ) : (
              <div className="workspace-empty">
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <BookOpen aria-hidden="true" />
                    </EmptyMedia>
                    <EmptyTitle>Choose a comment to review</EmptyTitle>
                    <EmptyDescription>
                      Read its source, shape a draft, and keep the useful
                      knowledge with explicit approval.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
                <div className="review-steps">
                  <span>01 · Read the evidence</span>
                  <span>02 · Save your draft</span>
                  <span>03 · Approve the decision</span>
                </div>
              </div>
            )}
          </>
        ) : (
          <Feed
            key={`${view}:${selected}`}
            api={api}
            kind={view}
            commentId={selected}
            onAll={() => switchView(view)}
          />
        )}
      </main>
      <AlertDialog
        open={leave !== null}
        onOpenChange={(open) => {
          if (!open) setLeave(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave this draft?</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved edits or an unresolved approval response. Stay to
              save or resolve it, or explicitly discard local changes. Saved
              work remains on the server.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay and review</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const action = leave;
                setLeave(null);
                setDirty(false);
                action?.();
              }}
            >
              Discard local changes and leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
