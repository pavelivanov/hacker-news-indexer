import { useEffect, useRef, useState } from "react";
import {
  validateClassificationV1,
  type ManualDraftV1,
  type ManualFinalizeV1,
} from "@hn-knowledge/contracts";
import { Check, Save, ArrowLeft, LoaderCircle } from "lucide-react";
import {
  ApiError,
  errorMessage,
  type Api,
  type CommentDetail,
  type FeedKind,
} from "../lib/api";
import {
  clearEvidence,
  initialDraft,
  missingFields,
  type Draft,
  type EvidenceTarget,
  label,
} from "../lib/draft";
import { SourcePane } from "./source-pane";
import { DraftForm } from "./draft-form";
import { TextField } from "./form-fields";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Skeleton } from "./ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
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

export function DraftSummary({ value }: { value: Draft }) {
  return (
    <div className="draft-summary">
      <p>{label(value.primary_decision ?? "Unfinished")}</p>
      {value.discoveries?.map((item, index) => (
        <div key={index}>
          <h3>{item.name || "Untitled discovery"}</h3>
          <p>{item.description_claim}</p>
        </div>
      ))}
      {value.expert_note ? (
        <div>
          <h3>{value.expert_note.title || "Untitled note"}</h3>
          <p>{value.expert_note.summary}</p>
        </div>
      ) : null}
      <p>{value.comment_relevance?.reason}</p>
      {value.rejection_reasons?.map((reason) => (
        <p key={reason}>{label(reason)}</p>
      ))}
    </div>
  );
}

export function ReviewEditor({
  id,
  api,
  onState,
  onPublished,
  onBack,
}: {
  id: number;
  api: Api;
  onState: (dirty: boolean, busy: boolean) => void;
  onPublished: (
    kind: FeedKind | "rejected",
    id: number,
    warnings: readonly string[],
  ) => void;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<CommentDetail | null>(null);
  const [draft, setDraft] = useState<ManualDraftV1 | null>(null);
  const [value, setValue] = useState<Draft>(() => initialDraft());
  const [baseline, setBaseline] = useState("");
  const [target, setTarget] = useState<EvidenceTarget>("note");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [status, setStatus] = useState("");
  const [reason, setReason] = useState("");
  const [latest, setLatest] = useState<CommentDetail | null>(null);
  const [rebaseOpen, setRebaseOpen] = useState(false);
  const [pending, setPending] = useState<{
    action: "approve" | "reject";
    body: ManualFinalizeV1;
  } | null>(null);
  const inFlight = useRef(false);
  const active = useRef(true);
  const terminal = draft !== null && draft.state !== "DRAFT";
  const dirty =
    draft !== null && !terminal && JSON.stringify(value) !== baseline;
  const stale = !!draft && !!detail && draft.source_hash !== detail.source_hash;
  const missing = missingFields(value, detail?.source ?? null);
  const savedComplete =
    draft !== null && validateClassificationV1(draft.payload).ok;
  const adopt = (next: ManualDraftV1) => {
    const normalized = initialDraft(next.payload);
    setDraft(next);
    setValue(normalized);
    setBaseline(JSON.stringify(normalized));
    setTarget(
      normalized.expert_note
        ? "note"
        : normalized.discoveries?.length
          ? "discovery:0"
          : "relevance",
    );
    setPending(null);
  };
  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    void api
      .comment(id, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setDetail(next);
        if (next.draft) adopt(next.draft);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      active.current = false;
      controller.abort();
    };
  }, [api, id]);
  useEffect(() => {
    onState(dirty || pending !== null || reason.trim().length > 0, busy);
  }, [dirty, pending, reason, busy, onState]);
  useEffect(() => () => onState(false, false), [onState]);
  const run = async (operation: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setStatus("");
    try {
      await operation();
    } catch (failure) {
      if (active.current) setError(failure);
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
      if (!draft) return;
      const result = await api.save(draft.id, {
        expected_version: draft.version,
        source_hash: draft.source_hash,
        payload: value,
      });
      adopt(result.draft);
      setStatus("Draft saved. You can return to it later.");
    });
  const finalize = () =>
    run(async () => {
      if (!draft || dirty || !savedComplete || missing.length || !reason.trim())
        return;
      const command = pending ?? {
        action:
          value.primary_decision === "REJECTED"
            ? ("reject" as const)
            : ("approve" as const),
        body: {
          expected_version: draft.version,
          source_hash: draft.source_hash,
          command_key: crypto.randomUUID(),
          reason: reason.trim(),
        },
      };
      setPending(command);
      try {
        const result = await api.finalize(
          draft.id,
          command.action,
          command.body,
        );
        adopt(result.draft);
        onPublished(
          command.action === "reject"
            ? "rejected"
            : value.primary_decision === "DISCOVERY"
              ? "discovery"
              : "expert_note",
          id,
          result.warnings,
        );
      } catch (failure) {
        if (failure instanceof ApiError && failure.status < 500)
          setPending(null);
        throw failure;
      }
    });
  const refresh = () =>
    run(async () => {
      setLatest(await api.comment(id));
    });
  const rebase = () =>
    run(async () => {
      if (!draft) return;
      const result = await api.rebase(draft.id, draft.version);
      const current = await api.comment(id);
      setDraft(result.draft);
      setBaseline(JSON.stringify(initialDraft(result.draft.payload)));
      setValue(clearEvidence(value));
      setDetail(current);
      setPending(null);
      setStatus(
        "Source refreshed. Your writing is preserved. Select evidence again, then save.",
      );
    });
  const chooseEvidence = (next: EvidenceTarget) => {
    setTarget(next);
    const pane = document.getElementById("source-evidence");
    pane?.focus();
    pane?.scrollIntoView({ block: "nearest", behavior: "instant" });
  };
  if (loading)
    return (
      <div className="loading-workspace" role="status">
        <p>Loading source…</p>
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  if (!detail)
    return (
      <div className="loading-workspace">
        <Alert>
          <AlertTitle>Source could not be loaded</AlertTitle>
          <AlertDescription>{errorMessage(error)}</AlertDescription>
        </Alert>
        <Button variant="outline" onClick={onBack}>
          Back to inbox
        </Button>
      </div>
    );
  return (
    <div className="review-panes">
      <div className="mobile-back">
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          <ArrowLeft data-icon="inline-start" aria-hidden="true" />
          Back to inbox
        </Button>
        <a href="#draft-editor">Go to draft</a>
      </div>
      <SourcePane
        detail={detail}
        value={value}
        target={target}
        setTarget={setTarget}
        onChange={setValue}
        disabled={!draft || terminal || busy || stale || !!pending}
      />
      <section
        className="editor-pane panel-scroll"
        id="draft-editor"
        aria-label="Draft editor"
      >
        <div className="pane-heading">
          <div>
            <p className="eyebrow">Your review</p>
            <h2>{terminal ? "Reviewed decision" : "Draft editor"}</h2>
          </div>
          <Badge variant="outline">
            {terminal
              ? label(draft.state)
              : dirty
                ? "Unsaved changes"
                : draft
                  ? `Saved · v${draft.version}`
                  : "Not started"}
          </Badge>
        </div>
        <div role="status" aria-live="polite" className="save-status">
          {status}
        </div>
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Action needs attention</AlertTitle>
            <AlertDescription>{errorMessage(error)}</AlertDescription>
          </Alert>
        ) : null}
        {stale ? (
          <Alert>
            <AlertTitle>Source changed since this draft</AlertTitle>
            <AlertDescription>
              Your old evidence selections need to be replaced before saving or
              approving.
            </AlertDescription>
          </Alert>
        ) : null}
        {pending ? (
          <Alert>
            <AlertTitle>Approval response is uncertain</AlertTitle>
            <AlertDescription>
              Retry the same saved request to find its result. Editing is paused
              until it is resolved.
            </AlertDescription>
          </Alert>
        ) : null}
        {(error instanceof ApiError && error.status === 409) || stale ? (
          <div className="action-row">
            <Button variant="outline" disabled={busy} onClick={refresh}>
              Compare saved version
            </Button>
            <Button
              variant="outline"
              disabled={busy || terminal || !detail.available}
              onClick={() => setRebaseOpen(true)}
            >
              Rebase evidence
            </Button>
          </div>
        ) : null}
        {!draft ? (
          <div className="start-draft">
            <p>
              Read the source, then create a draft. You can save it before every
              field is complete.
            </p>
            <Button
              disabled={busy || !detail.available}
              onClick={() =>
                run(async () => {
                  const result = await api.create(id);
                  adopt(result.draft);
                  setStatus("Draft created.");
                })
              }
            >
              {busy ? "Creating…" : "Start draft"}
            </Button>
          </div>
        ) : terminal ? (
          <>
            <DraftSummary value={draft.payload} />
            {draft.state === "APPROVED" ? (
              <Button
                onClick={() =>
                  onPublished(
                    draft.payload.primary_decision === "DISCOVERY"
                      ? "discovery"
                      : "expert_note",
                    id,
                    [],
                  )
                }
              >
                View approved content
              </Button>
            ) : null}
            <p className="muted small">This decision is read-only.</p>
          </>
        ) : (
          <>
            <DraftForm
              value={value}
              onChange={setValue}
              source={detail.source}
              selectEvidence={chooseEvidence}
              target={target}
              disabled={busy || stale || !!pending}
            />
            <div className="approval-section">
              <h3>Finish your review</h3>
              <TextField
                label="Approval or rejection reason"
                disabled={busy || pending !== null}
                value={reason}
                onChange={(next) => {
                  if (!pending) setReason(next);
                }}
                maxLength={1000}
                multiline
                required
                description="Recorded with the decision. Approval uses your saved draft."
              />
              {missing.length ? (
                <div className="requirements" id="approval-requirements">
                  <p>Before approval</p>
                  <ul>
                    {missing.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {dirty || (!savedComplete && missing.length === 0) ? (
                <p className="muted small">
                  Save your changes before approving.
                </p>
              ) : null}
              <div className="editor-actions">
                <Button
                  variant="outline"
                  disabled={busy || stale || !!pending}
                  onClick={save}
                >
                  {busy ? (
                    <LoaderCircle
                      data-icon="inline-start"
                      aria-hidden="true"
                      className="spin"
                    />
                  ) : (
                    <Save data-icon="inline-start" aria-hidden="true" />
                  )}
                  Save draft
                </Button>
                <Button
                  disabled={
                    busy ||
                    dirty ||
                    !savedComplete ||
                    stale ||
                    !detail.available ||
                    missing.length > 0 ||
                    !reason.trim()
                  }
                  aria-describedby={
                    missing.length ? "approval-requirements" : undefined
                  }
                  onClick={finalize}
                >
                  <Check data-icon="inline-start" aria-hidden="true" />
                  {pending
                    ? "Retry saved approval"
                    : value.primary_decision === "REJECTED"
                      ? "Confirm rejection"
                      : "Approve saved draft"}
                </Button>
              </div>
            </div>
          </>
        )}
      </section>
      <Dialog
        open={latest !== null}
        onOpenChange={(open) => {
          if (!open) setLatest(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Compare the saved draft</DialogTitle>
            <DialogDescription>
              Your current writing stays in the editor until you choose an
              action below.
            </DialogDescription>
          </DialogHeader>
          <div className="comparison">
            <section>
              <h3>Your current writing</h3>
              <DraftSummary value={value} />
            </section>
            <section>
              <h3>Saved version {latest?.draft?.version}</h3>
              {latest?.draft ? (
                <DraftSummary value={latest.draft.payload} />
              ) : (
                <p>No saved draft.</p>
              )}
            </section>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLatest(null)}>
              Keep comparing
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                if (latest?.draft) {
                  adopt(latest.draft);
                  setDetail(latest);
                  setError(null);
                  setLatest(null);
                }
              }}
            >
              Discard my edits and load saved
            </Button>
            {latest?.draft?.state === "DRAFT" ? (
              <Button
                onClick={() => {
                  if (!latest.draft) return;
                  if (latest.draft.source_hash !== draft?.source_hash)
                    setValue(clearEvidence(value));
                  setDraft(latest.draft);
                  setBaseline(
                    JSON.stringify(initialDraft(latest.draft.payload)),
                  );
                  setDetail(latest);
                  setPending(null);
                  setLatest(null);
                  setError(null);
                  setStatus(
                    "Your edits are on the latest version. Review them before saving.",
                  );
                }}
              >
                Keep my edits on latest version
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={rebaseOpen} onOpenChange={setRebaseOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace evidence selections?</AlertDialogTitle>
            <AlertDialogDescription>
              This preserves your writing and clears every selected passage and
              URL. Select the new evidence and save before approval.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep current draft</AlertDialogCancel>
            <AlertDialogAction onClick={rebase}>
              Rebase and clear selections
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
