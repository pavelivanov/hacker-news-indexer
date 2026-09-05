# ADR 0008: Automatic local feed with operational recovery

- Status: Accepted by owner, 2026-09-05
- Extends: [ADR 0007](0007-classifier-results-feedback.md)

The owner authorized the recommended next A+B milestone: fresh results arrive
automatically, with processing status, bounded usage, and retry controls. This
extends the previous captured-only milestone to incremental local source intake.

The local supervisor starts a dedicated worker. It reads the configured Telegram
selection channel, resolves canonical HN comments with existing adapters, and
shows classifier results without human approval. Initial intake covers the most
recent 20 selection IDs; later checks continue from a durable cursor. Defaults
are a 30-minute check interval, 20 selections per batch, and 100 classifier
requests per UTC day. Validation retries consume the same request allowance.

Feed jobs use a separate queue lane and a session lock shared with the local
batch generator. Immutable classifier attempt identities permit explicit retries
without replacing earlier predictions or feedback. Processing controls concern
operational recovery, not content verification. Pausing stops new dispatches;
the current item can finish.

Credentials remain in server processes. The old worker flags and hosted setup
remain unchanged. No deployment, automatic activation into the approved reader,
export, classifier-quality claim, prompt tuning, training, or new evaluation
cycle is part of this decision.
