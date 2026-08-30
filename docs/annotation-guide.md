# Annotation guide

This guide defines the conservative, mutually exclusive primary decision applied to each canonical selected HN comment. A Discovery may also contain useful expert commentary, but the primary decision records the comment's principal retained value.

## Primary decisions

- `DISCOVERY`: the comment materially identifies a named project, product, feature, guide, tool, library, service, plugin, agent skill, or resource. A generic root-story subject does not qualify when the selected comment is irrelevant.
- `EXPERT_NOTE`: the comment preserves a durable technical explanation, correction, comparison, implementation caveat, security observation, operational detail, guide, or first-hand product experience without being primarily a new discovery.
- `REJECTED`: the comment has no reusable technical value. Typical reasons include politics without a technical subject, a joke or one-liner, a generic opinion, an unrelated personal story, an incidental mention, news without reusable detail, or unavailable content.
- `REVIEW`: the system cannot safely publish or reject the result without human judgment. Review is also required when grounding, confidence, content state, or policy gates demand it.

`REJECTED` must not contain a Discovery or Expert note. `REVIEW` is not a low-effort fallback: its reason must be explicit and bounded.

### Priority ordering when classes overlap

- If a comment both names a tool and explains a mechanism, decide by its
  principal retained value: name + fact a reader could not reconstruct →
  `DISCOVERY`; durable explanation whose value survives even if you already
  knew the name → `EXPERT_NOTE`.
- If a comment is unusable _and_ the problem is content state (deleted, flagged,
  unavailable) rather than absence of value, prefer `REVIEW` over `REJECTED`
  only when the unavailability is the sole obstacle; otherwise `REJECTED`.
- `REVIEW` never wins a tie against a confident `DISCOVERY` or `EXPERT_NOTE`;
  it exists for genuine ambiguity or gate-triggered conditions, not hesitancy.

### Worked examples: DISCOVERY

All examples in this guide are invented paraphrases written for training; they
are not corpus rows.

1. Clear positive: "We open-sourced our WAL replay engine — it's called
   Rustream, MIT licensed, and it cut our restore times from hours to
   minutes." Names a project with an identifiable scope and retained fact.
   Class: `DISCOVERY`, subject `PROJECT`, evidence origin `COMMENT`.
2. Borderline-but-in: "Not many people know the pg_hint_plan extension also
   works on the forked planners in PG16+." The subject is best known as a
   tool, but the retained value is a capability fact of that named subject —
   a feature-level identification. `DISCOVERY` with subject `FEATURE`, because
   the deciding value is a nameable capability of a named subject, not a
   reusable explanation of how something works.
3. Near-miss (→ `EXPERT_NOTE`): "The reason Postgres got faster on read-only
   replicas is that the visibility map skips hint-bit setting during scans."
   No named subject is identified; the retained value is the mechanism
   explanation itself. Deciding reason: durable explanation with no new
   named thing → `EXPERT_NOTE` (`TECHNICAL_EXPLANATION`).

### Worked examples: EXPERT_NOTE

1. Clear positive: "Beware: if you set both `max.connections` and a pooler
   front-end, the pooler's idle timeout silently wins and you'll see phantom
   'server closed the connection' errors." A reusable implementation caveat
   that survives out of context. Class: `EXPERT_NOTE`,
   `IMPLEMENTATION_CAVEAT`.
2. Borderline-but-in: "After two years running this stack on spot instances
   I'd never again deploy it without a drain script in front of every
   rollout." First-hand experience, opinion-flavored, but it retains an
   operational prescription. Deciding reason: a concrete operational lesson,
   not a bare preference → `EXPERT_NOTE` (`OPERATIONS`).
3. Near-miss (→ `DISCOVERY`): "We solved exactly this with a small utility
   called drainomatic — link in profile." The retained value is the named
   tool, however briefly described. Deciding reason: principal value is the
   name + existence of a subject → `DISCOVERY`, subject `TOOL`.

### Worked examples: REJECTED

1. Clear positive: "Politicians will never understand databases, lol." No
   technical subject, no retained value. Class: `REJECTED`.
2. Borderline-but-in: "This reminds me of the time my startup died because
   our cofounder kept rewriting our schema." A first-hand anecdote, but it
   carries no generalizable technical content — no named subject, no
   mechanism, no reusable caveat. Deciding reason: personal narrative with
   zero retained technical value → `REJECTED`, not `PRODUCT_EXPERIENCE`.
3. Near-miss (→ `EXPERT_NOTE`): "We lost a weekend to this; the fix is to
   disable the optimizer's parallel scans on tables under 1 GB." Looks like a
   war story but retains a concrete, reusable fix. Deciding reason:
   generalizable remedy survives the anecdote → `EXPERT_NOTE`
   (`CORRECTION` or `IMPLEMENTATION_CAVEAT`).

### Worked examples: REVIEW

1. Clear positive: the comment text is present but grounds a security
   recommendation ("just set this TLS flag to 'unsafe' and move on") — policy
   gate demands human judgment. Class: `REVIEW`, reason: security
   recommendation.
2. Borderline-but-in: the selected comment reads "Deleted by author" and the
   root title alone hints at a tool name. Deciding reason: content state is
   unavailable and the only candidate evidence would be root-only, which
   requires review → `REVIEW`, not `REJECTED`, because unavailability — not
   lack of value — is the obstacle.
3. Near-miss (→ `REJECTED`): the comment is fully present and coherent but is
   a one-line joke about tabs versus spaces. Deciding reason: no gate
   triggers and there is nothing to judge — hesitancy is not a review reason
   → `REJECTED`.

### Materiality boundary: MATERIAL vs NOT_MATERIAL

Material relevance asks: stripped of its context, does this comment retain
technical value worth indexing? Decide materiality before the primary class.

- (a) Jokes that embed a real tool mention: `MATERIAL` if the joke still
  communicates a usable fact about a named subject (e.g. a pun whose punchline
  is that a specific library single-handedly fixed a specific failure mode).
  `NOT_MATERIAL` if the tool name is ornamental — the joke would land equally
  with any other name swapped in. The test: swap the name; if the retained
  value collapses, it is material.
- (b) First-hand war stories with no generalizable content: `NOT_MATERIAL`.
  "We hit this at 3 a.m. and everything was on fire" retains an emotion, not
  a fact. It becomes `MATERIAL` only if a cause, remedy, or tradeoff survives
  extraction.
- (c) News links with one-line commentary: `MATERIAL` only when the one line
  adds a retained fact ("this is the first release with the new allocator").
  A bare reaction ("huge if true", "about time") over a URL is
  `NOT_MATERIAL`: the comment itself contributes nothing indexable beyond the
  root story.
- (d) Meta-commentary about HN itself: comment threads about HN culture,
  voting, moderation, or the comment section are `NOT_MATERIAL` regardless of
  wit, unless the comment is principally about a named technical subject that
  happens to be HN-adjacent infrastructure.

Calibration clarification (2026-08-31): a named technical subject does not
make adjacent legal, political, moral, or consumer commentary material. After
removing the surrounding advocacy or emotion, the selected comment must still
add a concrete reusable technical element: a relationship, effect, constraint,
observed outcome, operational consequence, or bounded remedy. Do not infer a
technical consequence merely because one would make the comment useful.

- A terse correction may be `MATERIAL` without explaining the full mechanism
  when it states a specific, independently checkable technical relationship or
  counterfact. Bare contradiction, ridicule, or unsupported evaluation is
  `NOT_MATERIAL`.
- An analogy inside advocacy is `MATERIAL` only when the comparison itself maps
  technical processes, properties, constraints, or operational effects into a
  checkable claim. Applying the same legal, political, or moral principle to
  two technologies is insufficient.
- A stated preference, conditional refusal, or hypothetical future reaction is
  not `PRODUCT_EXPERIENCE` or an `IMPLEMENTATION_CAVEAT` without an observed
  outcome or a concrete reusable design tradeoff.
- Decide materiality before applying legal, medical, or security review gates.
  A gate routes an otherwise material result to review; it does not upgrade
  non-technical commentary into material content.

When genuinely torn, record `UNCERTAIN` with `AMBIGUOUS_CLASSIFICATION` — do
not force a guess and do not use `UNCERTAIN` as a shortcut past the structural
fields.

### Fully worked end-to-end example

Fabricated comment text (none of this is a corpus row):

> "Been running the queueless scheduler from that tiny Nordic consultancy —
> Skiplist, I think — for six months on our ingest cluster. One caveat: if
> your consumers exceed the partition count the broker degrades to polling
> instead of erroring, which looks like a slowdown, not a failure. Took us a
> week to find."

- `materialRelevance`: `MATERIAL` — a named subject plus a durable caveat
  survive out of context.
- Primary class: `EXPERT_NOTE`, note type `IMPLEMENTATION_CAVEAT`. Applying
  the priority ordering: the subject name is hedged ("I think") and secondary;
  the durable, hard-to-reconstruct content is the silent-degradation caveat,
  which survives even if you already knew the name.
- Subject (recorded separately): `Skiplist`, type `SERVICE` (remotely
  operated scheduling capability), evidence origin `COMMENT` with span
  "Skiplist" — hedged naming alone would not carry a Discovery, but the
  subject reference is still recorded.
- Evidence spans (UTF-16 offsets into `comment.plainText`): "Skiplist" for
  the subject name; "if your consumers exceed the partition count the broker
  degrades to polling instead of erroring" for the caveat; "six months on our
  ingest cluster" for the first-hand grounding (`PRODUCT_EXPERIENCE`
  secondary note).
- No review reason triggered: no URL claims, no security/destructive advice,
  no content-state problem.

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

`SECURITY` requires a concrete technical threat, vulnerability, control, risky
behavior, or operational exposure. Sanctions, legal designation, political
risk, or reputational risk to users or developers is not a security note
without such a technical consequence.

`CORRECTION` requires commenter-added counterevidence, a concrete counterfact,
or a specific independently checkable technical relationship. A precise quoted
premise followed only by an unsupported objection remains `GENERIC_OPINION`.

`PRODUCT_EXPERIENCE` requires actual use plus a substantive observed outcome,
constraint, or tradeoff; a preference or hypothetical response is not enough.

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

## Endgame decision rule

Pre-registered 2026-08-30, before any calibration corpus was labeled.

If the second calibration batch (Plan 009, Step 3) still fails to reach
κ ≥ 0.75 on either primary class or material relevance, the project adopts the
assist-only endpoint: `CLASSIFIER_ENABLED` remains false for automatic
decisions, all classification output is restricted to mandatory human review
(the existing behavior of `decision-router.v1` + the unpromoted-provider review
gate), Plan 003R is closed as satisfied-at-assist-level, and Plan 007
production deployment proceeds with the review-only classifier. No further
annotation cycles are opened.
