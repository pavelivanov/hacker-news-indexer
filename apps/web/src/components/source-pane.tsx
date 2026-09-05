import { ExternalLink } from "lucide-react";
import { Badge } from "./ui/badge";
import {
  Field,
  FieldLabel,
  FieldSet,
  FieldLegend,
  FieldGroup,
} from "./ui/field";
import { Checkbox } from "./ui/checkbox";
import { Alert, AlertTitle, AlertDescription } from "./ui/alert";
import { Choice } from "./form-fields";
import type { CommentDetail } from "../lib/api";
import {
  evidenceIds,
  setEvidence,
  type Draft,
  type EvidenceTarget,
} from "../lib/draft";

export function SourcePane({
  detail,
  value,
  target,
  setTarget,
  onChange,
  disabled,
}: {
  detail: CommentDetail;
  value: Draft;
  target: EvidenceTarget;
  setTarget: (target: EvidenceTarget) => void;
  onChange: (value: Draft) => void;
  disabled: boolean;
}) {
  const source = detail.source;
  const targets: EvidenceTarget[] = [
    "relevance",
    ...(value.expert_note ? ["note" as const] : []),
    ...(value.discoveries ?? []).map((_, i) => `discovery:${i}` as const),
  ];
  const selected = evidenceIds(value, target);
  return (
    <section
      className="source-pane panel-scroll"
      aria-label="Source evidence"
      id="source-evidence"
      tabIndex={-1}
    >
      <div className="pane-heading">
        <div>
          <p className="eyebrow">Original source</p>
          <h2>Evidence & context</h2>
        </div>
        <a
          href={`https://news.ycombinator.com/item?id=${detail.comment_id}`}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open comment ${detail.comment_id} on Hacker News`}
        >
          <ExternalLink size={17} aria-hidden="true" />
        </a>
      </div>
      {!detail.available ? (
        <Alert>
          <AlertTitle>Source unavailable</AlertTitle>
          <AlertDescription>
            This comment or its root is unavailable. It cannot be approved.
          </AlertDescription>
        </Alert>
      ) : null}
      {source ? (
        <>
          <div className="evidence-target">
            <Choice
              label="Choose evidence for"
              optionLabel={(entry) =>
                entry === "relevance"
                  ? "Comment relevance"
                  : entry === "note"
                    ? "Expert note"
                    : `Discovery ${Number(entry.split(":")[1]) + 1}`
              }
              value={target}
              values={targets}
              onChange={setTarget}
            />
            <p className="muted small">
              Select passages below. Each field keeps its own evidence.
            </p>
          </div>
          {source.truncation.some((entry) => entry.omittedRanges.length > 0) ? (
            <Alert>
              <AlertTitle>Bounded source excerpt</AlertTitle>
              <AlertDescription>
                Some source text is omitted. Only the displayed passages can
                support this draft.
              </AlertDescription>
            </Alert>
          ) : null}
          {source.documents.map((doc) => (
            <FieldSet key={doc.id} className="source-document">
              <FieldLegend>
                {doc.origin === "COMMENT"
                  ? "Selected comment"
                  : "Root story context"}
              </FieldLegend>
              <p className="muted small">
                HN #
                {doc.origin === "COMMENT"
                  ? source.selectedCommentId
                  : source.rootId}{" "}
                · {doc.spans.length} passages
              </p>
              <FieldGroup className="gap-0">
                {doc.spans.map((span, index) => (
                  <Field
                    orientation="horizontal"
                    key={span.id}
                    data-selected={selected.includes(span.id)}
                    className="evidence-row"
                  >
                    <Checkbox
                      id={`evidence-${span.id}`}
                      disabled={
                        disabled ||
                        (!selected.includes(span.id) &&
                          selected.length >= (target === "note" ? 16 : 12))
                      }
                      checked={selected.includes(span.id)}
                      onCheckedChange={(checked) =>
                        onChange(
                          setEvidence(
                            value,
                            target,
                            checked === true
                              ? [...selected, span.id]
                              : selected.filter((id) => id !== span.id),
                            source,
                          ),
                        )
                      }
                    />
                    <FieldLabel
                      htmlFor={`evidence-${span.id}`}
                      className="evidence-label"
                    >
                      <span className="evidence-meta">
                        Passage {index + 1} · {span.sourceStart}–
                        {span.sourceEnd}
                        {span.kind === "CODE" ? (
                          <Badge variant="outline">Code</Badge>
                        ) : null}
                      </span>
                      <span
                        className={
                          span.kind === "CODE" ? "source-code" : "source-text"
                        }
                      >
                        {span.text}
                      </span>
                    </FieldLabel>
                  </Field>
                ))}
              </FieldGroup>
            </FieldSet>
          ))}
        </>
      ) : null}
    </section>
  );
}
