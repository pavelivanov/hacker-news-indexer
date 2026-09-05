import { useEffect, useRef, useState } from "react";
import { PencilLine } from "lucide-react";
import {
  parseClassifierFeedbackV1,
  type ClassifierFeedbackV1,
} from "@hn-knowledge/contracts";
import {
  ApiError,
  errorMessage,
  type Api,
  type ResultDetail,
} from "../lib/api";
import { label } from "../lib/draft";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { FieldGroup } from "./ui/field";
import { Alert, AlertTitle, AlertDescription } from "./ui/alert";
import { Skeleton } from "./ui/skeleton";
import { RetryResult } from "./retry-result";
import { Choice, TextField } from "./form-fields";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";

export const resultCategoryLabel = (category: string) =>
  ({
    DISCOVERY: "Discovery",
    EXPERT_NOTE: "Expert note",
    REJECTED: "Skipped",
    REVIEW: "Uncertain",
    FAILED: "Processing failed",
  })[category] ?? category;
type Values = Omit<ClassifierFeedbackV1, "expected_version" | "command_key">;
const valuesFor = (data: ResultDetail): Values => ({
  category: data.category === "FAILED" ? "REVIEW" : data.category,
  title: data.title,
  summary: data.summary,
  issue: "OTHER",
  explanation: "",
});

export function ClassifierResultDetail({
  id,
  api,
  onState,
  onSaved,
}: {
  id: string;
  api: Api;
  onState: (dirty: boolean, busy: boolean) => void;
  onSaved: () => void;
}) {
  const [data, setData] = useState<ResultDetail | null>(null);
  const [values, setValues] = useState<Values | null>(null);
  const [baseline, setBaseline] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<ClassifierFeedbackV1 | null>(null);
  const flight = useRef(false);
  const dirty = !!values && JSON.stringify(values) !== baseline;
  useEffect(() => {
    onState(dirty || pending !== null, busy);
  }, [dirty, pending, busy, onState]);
  useEffect(() => {
    const controller = new AbortController();
    void api
      .result(id, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        const form = valuesFor(next);
        setData(next);
        setValues(form);
        setBaseline(JSON.stringify(form));
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      });
    return () => controller.abort();
  }, [id, api]);
  const submit = async () => {
    if (!data || !values || flight.current) return;
    let command: ClassifierFeedbackV1;
    try {
      command =
        pending ??
        parseClassifierFeedbackV1({
          ...values,
          expected_version: data.feedback_version,
          command_key: crypto.randomUUID(),
        });
    } catch {
      setError(
        "Choose a category. Discoveries and Expert notes need a title and summary.",
      );
      return;
    }
    flight.current = true;
    setBusy(true);
    setError("");
    setPending(command);
    try {
      await api.correctResult(id, command);
      const next = await api.result(id);
      const form = valuesFor(next);
      setData(next);
      setValues(form);
      setBaseline(JSON.stringify(form));
      setPending(null);
      setConflict(false);
      setOpen(false);
      setSaved(true);
      onSaved();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status < 500) setPending(null);
      if (failure instanceof ApiError && failure.status === 409) {
        setConflict(true);
        setError(
          "Another correction was saved. Your text is preserved. Load its version before saving your changes.",
        );
      } else
        setError(
          failure instanceof ApiError && failure.status === 400
            ? "Check the category, title, and summary before saving."
            : "The connection was interrupted. Retry the same correction to safely recover its saved result.",
        );
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  const useLatest = async () => {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    try {
      setData(await api.result(id));
      setConflict(false);
      setError(
        "Latest saved version loaded. Your text is still in the form; save to apply it.",
      );
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  if (!data || !values)
    return error ? (
      <Alert variant="destructive">
        <AlertTitle>Result unavailable</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    ) : (
      <div role="status">
        Loading result…
        <Skeleton className="h-32 w-full" />
      </div>
    );
  const original = data.original;
  const citations = new Set([
    ...(original?.discoveries.flatMap((item) => item.evidence_span_ids) ?? []),
    ...(original?.expert_note?.evidence_span_ids ?? []),
  ]);
  const update = (value: Partial<Values>) =>
    setValues((previous) => (previous ? { ...previous, ...value } : previous));
  return (
    <article className="classifier-detail">
      <div className="result-meta">
        <Badge variant="outline">{resultCategoryLabel(data.category)}</Badge>
        <span>
          {data.feedback_version ? "Corrected by you" : "AI generated"}
        </span>
      </div>
      <h1>{data.title}</h1>
      <p className="result-full-summary">{data.summary}</p>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <PencilLine data-icon="inline-start" aria-hidden="true" />
        {dirty ? "Continue correction" : "Correct result"}
      </Button>
      {saved ? (
        <p className="muted small" role="status">
          Correction saved for later improvements. The model has not been
          retrained.
        </p>
      ) : null}
      {!data.available ? (
        <Alert>
          <AlertTitle>Source no longer available</AlertTitle>
          <AlertDescription>
            The text below is the snapshot used for this prediction.
          </AlertDescription>
        </Alert>
      ) : null}
      {data.error_code ? (
        <Alert>
          <AlertTitle>Processing did not complete</AlertTitle>
          <AlertDescription>
            No usable prediction was returned. You can leave feedback or browse
            another comment.
          </AlertDescription>
        </Alert>
      ) : null}
      {data.error_code ? <RetryResult api={api} id={id} /> : null}
      <details className="result-original">
        <summary>Original prediction & model details</summary>
        <p className="muted small">
          {data.model} · {data.prompt_version} ·{" "}
          {new Date(data.created_at).toLocaleString()}
        </p>
        {original ? (
          <>
            <Badge variant="outline">
              {resultCategoryLabel(original.primary_decision)}
            </Badge>
            <p>{original.comment_relevance.reason}</p>
            {original.discoveries.map((item, index) => (
              <section key={index}>
                <h3>{item.name}</h3>
                <p>{item.description_claim}</p>
                {item.url_candidate_ids.map((urlId) => {
                  const candidate = data.source.urlCandidates.find(
                    (entry) => entry.id === urlId,
                  );
                  return candidate && /^https?:\/\//i.test(candidate.url) ? (
                    <a
                      key={urlId}
                      href={candidate.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Visit {item.name} ↗
                    </a>
                  ) : null;
                })}
              </section>
            ))}
            {original.expert_note ? (
              <section>
                <h3>{original.expert_note.title}</h3>
                <p>{original.expert_note.summary}</p>
              </section>
            ) : null}
            {original.review.reasons.length ? (
              <p className="muted small">
                Classifier flags:{" "}
                {original.review.reasons.map(label).join(", ")}
              </p>
            ) : null}
          </>
        ) : (
          <p>No validated prediction is available for this attempt.</p>
        )}
      </details>
      {data.feedback.length ? (
        <details className="result-history">
          <summary>Your correction history ({data.feedback.length})</summary>
          {data.feedback.map((item) => (
            <section key={item.id}>
              <p className="muted small">
                Version {item.version} ·{" "}
                {new Date(item.created_at).toLocaleString()}
              </p>
              <h3>{item.title || resultCategoryLabel(item.category)}</h3>
              <p>
                {resultCategoryLabel(item.category)} · {label(item.issue)}
              </p>
              <p>{item.summary}</p>
              {item.explanation ? <p>{item.explanation}</p> : null}
            </section>
          ))}
        </details>
      ) : null}
      <section className="result-source" aria-label="Original source snapshot">
        <p className="eyebrow">Source used by the classifier</p>
        <h2>Read the source</h2>
        <a
          href={`https://news.ycombinator.com/item?id=${data.comment_id}`}
          target="_blank"
          rel="noreferrer"
        >
          Open comment #{data.comment_id} on Hacker News ↗
        </a>
        {data.source.truncation.some(
          (item) => item.omittedRanges.length > 0,
        ) ? (
          <p className="muted small">
            This is a bounded excerpt. Some source text was omitted from the
            classifier input.
          </p>
        ) : null}
        {data.source.documents.map((document) => (
          <section key={document.id}>
            <h3>
              {document.origin === "COMMENT"
                ? "Selected comment"
                : "Root story context"}
            </h3>
            {document.spans.map((span) => (
              <blockquote key={span.id} data-cited={citations.has(span.id)}>
                <p
                  className={
                    span.kind === "CODE" ? "source-code" : "source-text"
                  }
                >
                  {span.text}
                </p>
                <cite>
                  {citations.has(span.id) ? "Cited by classifier · " : ""}
                  characters {span.sourceStart}–{span.sourceEnd}
                </cite>
              </blockquote>
            ))}
          </section>
        ))}
      </section>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent className="correction-dialog">
          <DialogHeader>
            <DialogTitle>Correct this result</DialogTitle>
            <DialogDescription>
              Update what you see and save feedback for later improvements. The
              original prediction stays available.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <FieldGroup>
              <Choice
                label="Category"
                value={values.category}
                values={["DISCOVERY", "EXPERT_NOTE", "REJECTED", "REVIEW"]}
                optionLabel={resultCategoryLabel}
                disabled={busy || !!pending}
                onChange={(category) =>
                  update({ category, issue: "WRONG_CATEGORY" })
                }
              />
              <TextField
                label="Title"
                value={values.title}
                maxLength={240}
                required={["DISCOVERY", "EXPERT_NOTE"].includes(
                  values.category,
                )}
                disabled={busy || !!pending}
                onChange={(title) => update({ title })}
              />
              <TextField
                label="Summary"
                value={values.summary}
                maxLength={8000}
                multiline
                required={["DISCOVERY", "EXPERT_NOTE"].includes(
                  values.category,
                )}
                disabled={busy || !!pending}
                onChange={(summary) =>
                  update({
                    summary,
                    issue:
                      values.issue === "OTHER"
                        ? "INACCURATE_SUMMARY"
                        : values.issue,
                  })
                }
              />
              <Choice
                label="What needs improving?"
                value={values.issue}
                values={[
                  "WRONG_CATEGORY",
                  "INACCURATE_SUMMARY",
                  "NOT_USEFUL",
                  "MISSING_CONTEXT",
                  "OTHER",
                ]}
                disabled={busy || !!pending}
                onChange={(issue) => update({ issue })}
              />
              <TextField
                label="Anything else?"
                description="Optional context to help with future improvements."
                value={values.explanation}
                maxLength={2000}
                multiline
                disabled={busy || !!pending}
                onChange={(explanation) => update({ explanation })}
              />
              {error ? (
                <Alert variant={conflict ? "default" : "destructive"}>
                  <AlertTitle>
                    {conflict
                      ? "A newer correction exists"
                      : "Correction status"}
                  </AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                  {conflict ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={useLatest}
                    >
                      Use latest version, keep my text
                    </Button>
                  ) : null}
                </Alert>
              ) : null}
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setOpen(false)}
                >
                  Close
                </Button>
                <Button
                  type="submit"
                  disabled={busy || conflict || (!dirty && !pending)}
                >
                  {busy
                    ? "Saving…"
                    : pending
                      ? "Retry same correction"
                      : "Save correction"}
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>
    </article>
  );
}
