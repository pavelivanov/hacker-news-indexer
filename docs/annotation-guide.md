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
