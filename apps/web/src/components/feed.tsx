import { useEffect, useState } from "react";
import type { FeedItemV1 } from "@hn-knowledge/contracts";
import { ArrowUpRight, BookOpen } from "lucide-react";
import { errorMessage, type Api, type FeedKind } from "../lib/api";
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

export function Feed({
  api,
  kind,
  commentId,
  onAll,
}: {
  api: Api;
  kind: FeedKind;
  commentId: number | null;
  onAll: () => void;
}) {
  const [items, setItems] = useState<FeedItemV1[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      if (commentId) {
        const result = await api.publishedComment(commentId, controller.signal);
        if (!controller.signal.aborted)
          setItems(result.items.filter((item) => item.kind === kind));
      } else {
        const result = await api.feed(kind, null, controller.signal);
        if (!controller.signal.aborted) {
          setItems([
            ...result.items,
            ...result.story_clusters.flatMap((cluster) => cluster.items),
          ]);
          setCursor(result.next_cursor);
        }
      }
    };
    setLoading(true);
    setError(null);
    void load()
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, kind, commentId, retry]);
  const more = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.feed(kind, cursor);
      setItems((previous) => [
        ...new Map(
          [
            ...previous,
            ...result.items,
            ...result.story_clusters.flatMap((cluster) => cluster.items),
          ].map((item) => [item.id, item]),
        ).values(),
      ]);
      setCursor(result.next_cursor);
    } catch (failure) {
      setError(failure);
    } finally {
      setLoading(false);
    }
  };
  return (
    <section className="feed-page panel-scroll" aria-label="Approved feed">
      <div className="feed-heading">
        <div>
          <p className="eyebrow">Your knowledge collection</p>
          <h1>{kind === "discovery" ? "Discoveries" : "Expert notes"}</h1>
          <p className="muted">Reviewed knowledge, with its source attached.</p>
        </div>
        {commentId ? (
          <Button variant="outline" onClick={onAll}>
            View all {kind === "discovery" ? "discoveries" : "notes"}
          </Button>
        ) : null}
      </div>
      {error ? (
        <Alert>
          <AlertTitle>Feed could not be loaded</AlertTitle>
          <AlertDescription>{errorMessage(error)}</AlertDescription>
          <Button variant="outline" onClick={() => setRetry((n) => n + 1)}>
            Retry feed
          </Button>
        </Alert>
      ) : null}
      {loading && !items.length ? (
        <div role="status">
          <p>Loading approved content…</p>
          <Skeleton className="h-32 w-full" />
        </div>
      ) : null}
      {!loading && !error && !items.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BookOpen aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>
              {commentId
                ? "No published items for this view"
                : "Your collection starts with a review"}
            </EmptyTitle>
            <EmptyDescription>
              {commentId
                ? "The decision was recorded, but no item is currently visible under reader policy. Check any URL or subject review warnings."
                : "Save and approve a draft from the inbox. Its supported content will appear here."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      <div className="feed-list">
        {items.map((item) => (
          <article className="feed-item" key={item.id}>
            <div className="feed-meta">
              <Badge variant="secondary">Approved</Badge>
              <span>
                {new Intl.DateTimeFormat(undefined, {
                  dateStyle: "medium",
                }).format(new Date(item.published_at))}
              </span>
              <span>HN #{item.selected_comment_id}</span>
            </div>
            <h2>{item.title}</h2>
            <p className="feed-summary">{item.summary}</p>
            {item.subjects.length ? (
              <p className="muted small">
                {item.subjects.map((subject) => subject.name).join(" · ")}
              </p>
            ) : null}
            <div className="feed-evidence">
              {item.evidence.map((span, index) => (
                <blockquote key={index}>
                  <p>{span.excerpt}</p>
                  <cite>
                    {span.origin === "COMMENT"
                      ? "Selected comment"
                      : "Root story"}{" "}
                    · characters {span.start_offset}–{span.end_offset}
                  </cite>
                </blockquote>
              ))}
            </div>
            <a
              href={`https://news.ycombinator.com/item?id=${item.selected_comment_id}`}
              target="_blank"
              rel="noreferrer"
            >
              Read source on Hacker News{" "}
              <ArrowUpRight size={15} aria-hidden="true" />
            </a>
          </article>
        ))}
      </div>
      {!commentId && cursor ? (
        <Button variant="outline" disabled={loading} onClick={more}>
          {loading ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </section>
  );
}
