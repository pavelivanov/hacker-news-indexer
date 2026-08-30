# Annotation guide

This guide defines the conservative, mutually exclusive primary decision applied to each canonical selected HN comment. A Discovery may also contain useful expert commentary, but the primary decision records the comment's principal retained value.

## Primary decisions

- `DISCOVERY`: the comment materially identifies a named project, product, feature, guide, tool, library, service, plugin, agent skill, or resource. A generic root-story subject does not qualify when the selected comment is irrelevant.
- `EXPERT_NOTE`: the comment preserves a durable technical explanation, correction, comparison, implementation caveat, security observation, operational detail, guide, or first-hand product experience without being primarily a new discovery.
- `REJECTED`: the comment has no reusable technical value. Typical reasons include politics without a technical subject, a joke or one-liner, a generic opinion, an unrelated personal story, an incidental mention, news without reusable detail, or unavailable content.
- `REVIEW`: the system cannot safely publish or reject the result without human judgment. Review is also required when grounding, confidence, content state, or policy gates demand it.

`REJECTED` must not contain a Discovery or Expert note. `REVIEW` is not a low-effort fallback: its reason must be explicit and bounded.

## Evidence origins

- `COMMENT`: every relevant claim and subject name is supported by validated spans in the selected comment.
- `ROOT_STORY`: evidence comes only from the resolved root title or text. Root-only discoveries require review and appear only once per root and subject.
- `BOTH`: the result contains at least one validated selected-comment span and at least one validated root span.

Each subject mention, Discovery, and note records its own evidence origin. Evidence offsets must reproduce the supplied source text exactly; a classifier may never invent a URL or cite an unavailable source.

## Subject types

- `PROJECT`: a cohesive open or closed project.
- `TOOL`: a focused technical utility.
- `LIBRARY`: reusable software intended for integration into other software.
- `SERVICE`: a remotely operated capability.
- `PRODUCT`: a packaged end-user or enterprise offering.
- `FEATURE`: a distinct capability of a broader subject.
- `PLUGIN`: an extension loaded by a host system.
- `AGENT_SKILL`: reusable instructions or tooling for an agent.
- `GUIDE`: procedural technical instruction.
- `RESOURCE`: useful technical material that does not fit a narrower type.

## Expert-note types

- `TECHNICAL_EXPLANATION`: explains a mechanism or technical concept.
- `CORRECTION`: corrects a material claim or interpretation.
- `PRODUCT_EXPERIENCE`: reports substantive first-hand use.
- `IMPLEMENTATION_CAVEAT`: identifies a constraint, edge case, or tradeoff.
- `SECURITY`: covers threats, vulnerabilities, controls, or risky behavior.
- `OPERATIONS`: covers deployment, reliability, maintenance, or incident practice.
- `COMPARISON`: contrasts technologies or approaches with reusable detail.
- `GUIDE`: gives bounded procedural technical advice.

## Review reasons

Create a review task for missing or ambiguous canonical URLs; normalized-name-only subject merges; root-story-only discoveries; legal, medical, or security recommendations; destructive or evasion-oriented advice; low confidence; prompt-injection signals; flagged, deleted, or unavailable content; Telegram/HN divergence; conflicting evidence origins; invalid evidence spans; unsupported or ungrounded URLs; or ambiguous classification.

FindThatProject export always requires review during initial rollout and is limited to an approved, high-confidence Discovery with an explicit subject type, a grounded HTTP(S) canonical URL, selected-comment materiality, present evidence origin, and no unresolved flags. Expert notes are not exportable in v1.

## Fresh-cycle independent passes

Fresh cycles separate material relevance from the final primary class. Record
`materialRelevance` as `MATERIAL`, `NOT_MATERIAL`, or `UNCERTAIN`, then make the
best bounded `DISCOVERY`, `EXPERT_NOTE`, or `REJECTED` decision. An uncertain
materiality decision must include `AMBIGUOUS_CLASSIFICATION`; it does not permit
skipping evidence or the remaining structural fields.

If either kappa gate fails, that cycle is terminal annotation evidence. Do not
show row-level disagreements to the annotators, reconcile the failed rows, or
repeat labels until agreement happens to pass. Calibrate the materiality
boundary on a separate corpus excluded from every evaluation cycle. Annotators
may discuss only those calibration rows. Revise this guide only from that
separate exercise, require agreement on a second excluded calibration batch,
then label a later fresh cycle independently from scratch.

Each annotator receives only their own shuffled packet directory, this guide,
and `evaluation/annotation-pass-schema-v2.json`. They must not receive the
other pass, model predictions, historical class totals or examples, the cycle
manifest, or the holdout ID file. Annotators may use only packet text and URL
candidates; they must not browse or fetch external pages.

Annotation-pass output is one JSON object per line with schema version
`annotation-pass.v2`. Evidence offsets use JavaScript UTF-16 coordinates into
the supplied `comment.plainText` or `root.plainText`. Copy exact evidence text,
use no more than 32 distinct evidence spans per row, and return only opaque
`url:<n>` candidate IDs in discoveries. Derived names, descriptions, note
text, aliases, and qualifiers must not contain raw URLs.
Use annotator IDs `A` and `B` respectively and method
`independent-bounded-review`.

After both passes validate, the comparison gate calculates Cohen's kappa
independently for material relevance and primary class. Both must be at least
0.75. The adjudicator receives only the generated disagreement packet, which
contains the bounded source and the two independent proposals; they must not
receive holdout assignments, model predictions, or historical targets. Every
resolved disagreement requires a written rationale in the later adjudicated
gold artifact.

Return one `annotation-adjudication.v2` JSONL row for every packet row using
`evaluation/annotation-adjudication-schema-v2.json`. Select either the complete
A proposal or the complete B proposal; do not invent a third label or combine
their extraction fields. Record a stable adjudicator ID, use method
`bounded-disagreement-review`, and write a source-bounded rationale of at least
20 characters without raw URLs. If a packet contains no rows, the response is
an empty file.
