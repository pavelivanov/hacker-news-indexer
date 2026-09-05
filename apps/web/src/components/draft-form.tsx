import type { ClassificationV1 } from "@hn-knowledge/contracts";
import { Plus, Quote, Trash2 } from "lucide-react";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "./ui/field";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { Separator } from "./ui/separator";
import { TextField, Choice, CheckField, CheckSet } from "./form-fields";
import {
  changeClass,
  evidenceIds,
  newDiscovery,
  newNote,
  noteTypes,
  rejectionReasons,
  reviewReasons,
  setConfidence,
  subjectTypes,
  type Draft,
  type EvidenceTarget,
  type Note,
  type Discovery,
} from "../lib/draft";
import type { CommentDetail } from "../lib/api";

export function DraftForm({
  value,
  onChange,
  source,
  selectEvidence,
  target,
  disabled,
}: {
  value: Draft;
  onChange: (value: Draft) => void;
  source: CommentDetail["source"];
  selectEvidence: (target: EvidenceTarget) => void;
  target: EvidenceTarget;
  disabled: boolean;
}) {
  const note = value.expert_note;
  const patchNote = (patch: Partial<Note>) =>
    onChange({ ...value, expert_note: { ...note, ...patch } });
  const patchDiscovery = (index: number, patch: Partial<Discovery>) =>
    onChange({
      ...value,
      discoveries: value.discoveries?.map((item, i) =>
        i === index ? { ...item, ...patch } : item,
      ),
    });
  const evidenceButton = (forTarget: EvidenceTarget, title: string) => (
    <Button
      type="button"
      variant={target === forTarget ? "secondary" : "outline"}
      onClick={() => selectEvidence(forTarget)}
    >
      <Quote aria-hidden="true" data-icon="inline-start" />
      {title} · {evidenceIds(value, forTarget).length} selected
    </Button>
  );
  return (
    <fieldset disabled={disabled} className="draft-fields">
      <legend className="sr-only">Draft fields</legend>
      <FieldGroup>
        <Field>
          <FieldLabel id="class-label">Keep as</FieldLabel>
          <ToggleGroup
            type="single"
            variant="outline"
            aria-labelledby="class-label"
            value={value.primary_decision ?? "EXPERT_NOTE"}
            onValueChange={(kind) => {
              if (kind) {
                onChange(
                  setConfidence(
                    changeClass(
                      value,
                      kind as ClassificationV1["primary_decision"],
                    ),
                    value.decision_confidence,
                  ),
                );
                selectEvidence(
                  kind === "EXPERT_NOTE"
                    ? "note"
                    : kind === "DISCOVERY"
                      ? "discovery:0"
                      : "relevance",
                );
              }
            }}
          >
            <ToggleGroupItem value="EXPERT_NOTE">Expert note</ToggleGroupItem>
            <ToggleGroupItem value="DISCOVERY">Discovery</ToggleGroupItem>
            <ToggleGroupItem value="REJECTED">Reject</ToggleGroupItem>
          </ToggleGroup>
        </Field>
        {value.primary_decision === "DISCOVERY" ? (
          <>
            {value.discoveries?.map((item, index) => (
              <FieldSet key={index}>
                <FieldLegend>Discovery {index + 1}</FieldLegend>
                <FieldGroup>
                  <Choice
                    label={`Subject type ${index + 1}`}
                    value={item.subject_type}
                    values={subjectTypes}
                    onChange={(subject_type) =>
                      patchDiscovery(index, { subject_type })
                    }
                  />
                  <TextField
                    label={`Discovery name ${index + 1}`}
                    value={item.name}
                    onChange={(name) => patchDiscovery(index, { name })}
                    maxLength={160}
                    required
                    description="Use the name as it appears in the evidence."
                  />
                  <TextField
                    label={`Discovery description ${index + 1}`}
                    value={item.description_claim}
                    onChange={(description_claim) =>
                      patchDiscovery(index, { description_claim })
                    }
                    maxLength={1000}
                    multiline
                    required
                  />
                  {evidenceButton(
                    `discovery:${index}`,
                    `Discovery ${index + 1} evidence`,
                  )}
                  <FieldSet>
                    <FieldLegend variant="label">Source URLs</FieldLegend>
                    <FieldDescription>
                      Only URLs captured with this source can be selected.
                    </FieldDescription>
                    <FieldGroup className="gap-3">
                      {source?.urlCandidates.length ? (
                        source.urlCandidates.map((candidate) => (
                          <CheckField
                            key={candidate.id}
                            label={candidate.url}
                            checked={
                              item.url_candidate_ids?.includes(candidate.id) ??
                              false
                            }
                            onChange={(checked) => {
                              const ids = checked
                                ? [
                                    ...(item.url_candidate_ids ?? []),
                                    candidate.id,
                                  ].slice(0, 12)
                                : (item.url_candidate_ids?.filter(
                                    (id) => id !== candidate.id,
                                  ) ?? []);
                              patchDiscovery(index, {
                                url_candidate_ids: ids,
                                url_grounding: ids.length ? "GROUNDED" : "NONE",
                              });
                            }}
                          />
                        ))
                      ) : (
                        <FieldDescription>
                          No source URL is available. The discovery may need URL
                          review.
                        </FieldDescription>
                      )}
                    </FieldGroup>
                  </FieldSet>
                  <details>
                    <summary>Aliases</summary>
                    <TextField
                      label={`Aliases ${index + 1}`}
                      value={item.aliases?.join("\n")}
                      onChange={(text) =>
                        patchDiscovery(index, {
                          aliases: [...new Set(text.split("\n"))].slice(0, 10),
                        })
                      }
                      maxLength={1609}
                      multiline
                      description="One name per line, up to 10. Remove empty lines before approval."
                    />
                  </details>
                  {(value.discoveries?.length ?? 0) > 1 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        onChange({
                          ...value,
                          discoveries: value.discoveries?.filter(
                            (_, i) => i !== index,
                          ),
                        });
                        selectEvidence("relevance");
                      }}
                    >
                      <Trash2 data-icon="inline-start" aria-hidden="true" />
                      Remove discovery {index + 1}
                    </Button>
                  ) : null}
                </FieldGroup>
              </FieldSet>
            ))}
            <Button
              type="button"
              variant="outline"
              disabled={(value.discoveries?.length ?? 0) >= 5}
              onClick={() =>
                onChange({
                  ...value,
                  discoveries: [
                    ...(value.discoveries ?? []),
                    {
                      ...newDiscovery(),
                      confidence: value.decision_confidence,
                    },
                  ],
                })
              }
            >
              <Plus data-icon="inline-start" aria-hidden="true" />
              Add another discovery
            </Button>
            <CheckField
              label="Include a supporting Expert note"
              checked={!!note}
              onChange={(checked) => {
                onChange({
                  ...value,
                  expert_note: checked
                    ? { ...newNote(), confidence: value.decision_confidence }
                    : null,
                });
                selectEvidence("relevance");
              }}
            />
          </>
        ) : null}
        {note && value.primary_decision !== "REJECTED" ? (
          <FieldSet>
            <FieldLegend>
              {value.primary_decision === "DISCOVERY"
                ? "Supporting Expert note"
                : "Expert note"}
            </FieldLegend>
            <FieldGroup>
              <Choice
                label="Note type"
                value={note.note_type}
                values={noteTypes}
                onChange={(note_type) => patchNote({ note_type })}
              />
              <TextField
                label="Note title"
                value={note.title}
                onChange={(title) => patchNote({ title })}
                maxLength={200}
                required
              />
              <TextField
                label="Note summary"
                value={note.summary}
                onChange={(summary) => patchNote({ summary })}
                maxLength={2000}
                multiline
                required
                description="Keep the useful detail and its limitations."
              />
              {evidenceButton("note", "Expert note evidence")}
              <details>
                <summary>Related subjects and qualifiers</summary>
                <FieldGroup className="mt-4">
                  <TextField
                    label="Related subject names"
                    value={note.related_subject_names?.join("\n")}
                    onChange={(text) =>
                      patchNote({
                        related_subject_names: [
                          ...new Set(text.split("\n")),
                        ].slice(0, 12),
                      })
                    }
                    maxLength={1931}
                    multiline
                    description="One subject per line. Names are matched against existing subjects."
                  />
                  <TextField
                    label="Qualifiers"
                    value={note.qualifiers?.join("\n")}
                    onChange={(text) =>
                      patchNote({
                        qualifiers: [...new Set(text.split("\n"))].slice(0, 12),
                      })
                    }
                    maxLength={3611}
                    multiline
                    description="One limitation per line. Remove empty lines before approval."
                  />
                </FieldGroup>
              </details>
            </FieldGroup>
          </FieldSet>
        ) : null}
        {value.primary_decision === "REJECTED" ? (
          <CheckSet
            title="Why reject this comment?"
            values={rejectionReasons}
            selected={value.rejection_reasons ?? []}
            onChange={(rejection_reasons) =>
              onChange({ ...value, rejection_reasons })
            }
          />
        ) : null}
        <Separator />
        <FieldSet>
          <FieldLegend>Review judgment</FieldLegend>
          <FieldGroup>
            <CheckField
              label="The selected comment is materially technical"
              checked={
                value.comment_relevance?.is_materially_technical ?? false
              }
              onChange={(is_materially_technical) =>
                onChange({
                  ...value,
                  comment_relevance: {
                    ...value.comment_relevance,
                    is_materially_technical,
                  },
                })
              }
            />
            <TextField
              label="Relevance explanation"
              value={value.comment_relevance?.reason}
              onChange={(reason) =>
                onChange({
                  ...value,
                  comment_relevance: { ...value.comment_relevance, reason },
                })
              }
              maxLength={500}
              multiline
              required
            />
            {evidenceButton("relevance", "Relevance evidence")}
            <Field>
              <FieldLabel htmlFor="confidence">
                Your confidence (0–100%) *
              </FieldLabel>
              <Input
                id="confidence"
                name="confidence"
                type="number"
                min={0}
                max={100}
                step={1}
                inputMode="numeric"
                value={
                  value.decision_confidence === undefined
                    ? ""
                    : Math.round(value.decision_confidence * 100)
                }
                onChange={(event) => {
                  const number = event.target.valueAsNumber;
                  onChange(
                    setConfidence(
                      value,
                      Number.isFinite(number)
                        ? Math.min(100, Math.max(0, number)) / 100
                        : undefined,
                    ),
                  );
                }}
              />
              <FieldDescription>
                Your judgment of this decision and its extractions, not measured
                accuracy.
              </FieldDescription>
            </Field>
            <details>
              <summary>Content review flags</summary>
              <div className="mt-4">
                <CheckSet
                  title="Flag content that needs care"
                  values={reviewReasons}
                  selected={value.review?.reasons ?? []}
                  onChange={(reasons) =>
                    onChange({
                      ...value,
                      review: { required: reasons.length > 0, reasons },
                    })
                  }
                />
              </div>
            </details>
          </FieldGroup>
        </FieldSet>
      </FieldGroup>
    </fieldset>
  );
}
