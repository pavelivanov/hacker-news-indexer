import { lazy, Suspense, useRef, useState } from "react";
import { ArrowRight, LockKeyhole } from "lucide-react";
import { createApi, errorMessage, type Api } from "./lib/api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "./components/ui/field";
import { Alert, AlertTitle, AlertDescription } from "./components/ui/alert";

const Workspace = lazy(() =>
  import("./components/workspace").then((module) => ({
    default: module.Workspace,
  })),
);

export default function App() {
  const [api, setApi] = useState<Api | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const activeToken = useRef<string | null>(null);
  const lock = () => {
    activeToken.current = null;
    setApi(null);
    setInput("");
  };
  if (api)
    return (
      <Suspense
        fallback={
          <main className="loading-workspace" role="status">
            Opening workspace…
          </main>
        }
      >
        <Workspace api={api} onLock={lock} />
      </Suspense>
    );
  const unlock = async (event: React.SyntheticEvent) => {
    event.preventDefault();
    if (busy || !input.trim()) return;
    const token = input.trim();
    setInput("");
    setBusy(true);
    setError("");
    const client = createApi(token, () => {
      if (activeToken.current === token) {
        lock();
        setError("Your session ended. Unlock again to load your saved drafts.");
      }
    });
    try {
      await client.inbox("unreviewed");
      activeToken.current = token;
      setApi(client);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="unlock-page">
      <div className="unlock-brand brand">
        <span className="brand-mark">HN</span>
        <span>Knowledge</span>
      </div>
      <section className="unlock-content" aria-labelledby="unlock-title">
        <p className="eyebrow">
          <LockKeyhole size={16} aria-hidden="true" /> Private collection
        </p>
        <h1 id="unlock-title">Your knowledge feed.</h1>
        <p className="unlock-description">
          Browse discoveries and Expert notes from captured Hacker News
          comments. Correct a result whenever you want.
        </p>
        <form onSubmit={unlock}>
          <FieldGroup>
            <Field data-invalid={!!error}>
              <FieldLabel htmlFor="local-token">Local API token</FieldLabel>
              <Input
                id="local-token"
                name="local-token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                required
                disabled={busy}
                aria-invalid={!!error}
                aria-describedby="token-help"
              />
              <FieldDescription id="token-help">
                Use APP_API_TOKEN from your local environment file. The token
                stays in memory and clears when you reload or lock.
              </FieldDescription>
            </Field>
            {error ? (
              <Alert variant="destructive">
                <AlertTitle>Unable to unlock</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <Button type="submit" disabled={busy}>
              {busy ? "Unlocking…" : "Unlock workspace"}
              <ArrowRight data-icon="inline-end" aria-hidden="true" />
            </Button>
          </FieldGroup>
        </form>
        <p className="unlock-footnote">
          Results appear automatically. Your corrections are saved locally.
        </p>
      </section>
      <div className="unlock-index" aria-hidden="true">
        <span>READ</span>
        <span>DISCOVER</span>
        <span>RETAIN</span>
      </div>
    </main>
  );
}
