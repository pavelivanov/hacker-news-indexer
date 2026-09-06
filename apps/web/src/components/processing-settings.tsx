import { useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import {
  parseFeedSettingsV1,
  type FeedSettingsV1,
} from "@hn-knowledge/contracts";
import { ApiError, type Api, type ProcessingStatus } from "../lib/api";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "./ui/field";
import { Input } from "./ui/input";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";

const integerInRange = (text: string, maximum: number) =>
  text.trim() !== "" &&
  Number.isInteger(Number(text)) &&
  Number(text) >= 1 &&
  Number(text) <= maximum;

export function ProcessingSettings({
  api,
  status,
  disabled,
  onSaved,
}: {
  api: Api;
  status: ProcessingStatus;
  disabled: boolean;
  onSaved: (status: ProcessingStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  const [minutes, setMinutes] = useState("");
  const [limit, setLimit] = useState("");
  const [version, setVersion] = useState(0);
  const [baseline, setBaseline] = useState("");
  const [pending, setPending] = useState<FeedSettingsV1 | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const flight = useRef(false);
  const reset = (next: ProcessingStatus) => {
    setMinutes(String(next.interval_seconds / 60));
    setLimit(String(next.daily_request_limit));
    setVersion(next.settings_version);
    setBaseline(
      JSON.stringify([next.interval_seconds / 60, next.daily_request_limit]),
    );
    setAttempted(false);
    setConflict(false);
    setError("");
  };
  const intervalValid = integerInRange(minutes, 1440);
  const limitValid = integerInRange(limit, 1000);
  const changed = JSON.stringify([Number(minutes), Number(limit)]) !== baseline;
  const save = async () => {
    if (flight.current || conflict) return;
    setAttempted(true);
    if (!pending && (!intervalValid || !limitValid)) return;
    const command =
      pending ??
      parseFeedSettingsV1({
        interval_minutes: Number(minutes),
        daily_request_limit: Number(limit),
        expected_version: version,
        command_key: crypto.randomUUID(),
      });
    flight.current = true;
    setBusy(true);
    setPending(command);
    setError("");
    setNotice("");
    try {
      await api.saveProcessingSettings(command);
      const next = await api.processing();
      onSaved(next);
      reset(next);
      setPending(null);
      setNotice(
        "Settings saved. Current values are shown; today’s usage is unchanged.",
      );
    } catch (failure) {
      if (failure instanceof ApiError && failure.status < 500) {
        setPending(null);
        if (failure.status === 409) {
          setConflict(true);
          setError(
            "Settings changed in another tab. Your edits are still here. Reload current settings before saving again.",
          );
        } else
          setError(
            "Settings could not be saved. Check the values or reload current settings.",
          );
      } else
        setError(
          "The save response was interrupted. Retry the same settings to recover it safely.",
        );
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  const reload = async () => {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    try {
      const next = await api.processing();
      onSaved(next);
      reset(next);
      setNotice("");
    } catch {
      setError(
        "Could not reload settings. Your edits are still here; try again.",
      );
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  const frozen = busy || pending !== null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (next && !pending) {
          reset(status);
          setNotice("");
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || !status.configured}
        >
          <Settings2 data-icon="inline-start" aria-hidden="true" />
          Feed settings
        </Button>
      </DialogTrigger>
      <DialogContent
        className="processing-settings-dialog"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>Feed settings</DialogTitle>
          <DialogDescription>
            Choose how often to check for comments and how many classifier
            requests to allow each day.
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <FieldGroup>
            <Field
              data-invalid={attempted && !intervalValid}
              data-disabled={frozen}
            >
              <FieldLabel htmlFor="feed-interval">
                Check every (minutes)
              </FieldLabel>
              <Input
                id="feed-interval"
                type="number"
                inputMode="numeric"
                min={1}
                max={1440}
                step={1}
                value={minutes}
                disabled={frozen}
                aria-invalid={attempted && !intervalValid}
                aria-describedby="feed-interval-help feed-interval-error"
                onChange={(event) => {
                  setMinutes(event.target.value);
                  setNotice("");
                }}
              />
              <FieldDescription id="feed-interval-help">
                1–1,440 minutes. A changed interval starts from when you save.
              </FieldDescription>
              <FieldError id="feed-interval-error">
                {attempted && !intervalValid
                  ? "Enter a whole number from 1 to 1,440."
                  : null}
              </FieldError>
            </Field>
            <Field
              data-invalid={attempted && !limitValid}
              data-disabled={frozen}
            >
              <FieldLabel htmlFor="feed-limit">Daily request limit</FieldLabel>
              <Input
                id="feed-limit"
                type="number"
                inputMode="numeric"
                min={1}
                max={1000}
                step={1}
                value={limit}
                disabled={frozen}
                aria-invalid={attempted && !limitValid}
                aria-describedby="feed-limit-help feed-limit-error"
                onChange={(event) => {
                  setLimit(event.target.value);
                  setNotice("");
                }}
              />
              <FieldDescription id="feed-limit-help">
                1–1,000 requests. {status.requests_today} used today; resets at
                midnight UTC. This is a request cap, not a spending cap.
              </FieldDescription>
              <FieldError id="feed-limit-error">
                {attempted && !limitValid
                  ? "Enter a whole number from 1 to 1,000."
                  : null}
              </FieldError>
            </Field>
            <p className="muted small">
              Changes apply without restarting. Requests already started may
              finish. Paused updates stay paused.
            </p>
            {error ? (
              <Alert variant="destructive">
                <AlertTitle>Settings need attention</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            {conflict ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void reload()}
              >
                Reload current settings
              </Button>
            ) : null}
            {notice ? (
              <p className="muted small" role="status">
                {notice}
              </p>
            ) : null}
          </FieldGroup>
          <DialogFooter className="processing-settings-footer">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              {notice ? "Done" : "Cancel"}
            </Button>
            <Button
              type="submit"
              disabled={busy || conflict || (!pending && !changed)}
            >
              {busy
                ? "Saving…"
                : pending
                  ? "Retry same settings"
                  : "Save settings"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
