# ADR 0007: Private classifier results with optional corrections

- Status: Accepted by owner, 2026-09-05
- Supersedes: ADR 0006's mandatory review requirement for private browsing only.

The owner explicitly deferred verification of classifier quality until normal
project use and requested a friendly result interface with correction capture.
Machine results may therefore appear in the private results view immediately
after automated structural/grounding checks, without human approval.

Original predictions and bounded source snapshots remain immutable. Corrections
are separately attributed, versioned feedback and update the private display.
They are not automatic model training, accepted gold labels, or approval events.
Model provenance remains visible. Existing approved-reader/export controls and
terminal evaluation artifacts remain unchanged. No new cycle or prompt/model
tuning is authorized by this UI milestone; later improvements must handle
evaluation overlap explicitly before using collected feedback.

Local captured-comment generation is enabled through a bounded explicit command
using the existing configured provider. No worker/live intake or hosted change
is part of this decision. Operational failures remain visible and do not create
a mandatory human review task.

Subsequent decision: [ADR 0008](0008-local-automatic-feed.md) extends this private
workflow to bounded automatic local intake and processing recovery. It preserves
the optional-feedback policy and historical evaluation outcomes above.
