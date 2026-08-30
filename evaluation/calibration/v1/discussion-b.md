# Annotator B calibration discussion — batch 1

This discussion explains the four independent-pass disagreements. It does not revise either pass.

## 49487533 — model training, distillation, and copyright

I marked this `NOT_MATERIAL` / `REJECTED` because I read its principal value as a normative consistency argument about copyright and corporate conduct. It names technical processes, but it does not explain how training or distillation works, report an observed result, or give an implementation consequence.

Annotator A instead retained a concrete comparison: if book-to-model transformation is defended as transformative, model-to-model distillation can be tested against the same argument. That interpretation exposes a real boundary problem: a policy argument may contain a reusable comparison between technical processes even when its conclusion is legal or moral.

The general ambiguity is whether a mechanism-level analogy inside advocacy counts as technical value. The presence of technical nouns is insufficient, but a specific mapping between two processes can survive the rhetoric around it.

## 49478826 — sanctions applied to technical infrastructure

I marked this `NOT_MATERIAL` / `REJECTED` because the comment asks speculative legal-policy questions about whether users and developers could be treated as terrorists. It does not describe a security property, technical failure mode, operational effect, or change in how I2P, Monero, Veilid, Tox, or Signal functions.

Annotator A treated the cross-system sanction precedent as a security note and used `UNCERTAIN`. That highlights ambiguity between security in the technical sense and legal or political risk borne by people associated with security-related infrastructure.

The general boundary is technology-adjacent policy risk. Naming privacy, messaging, or cryptocurrency systems should not by itself turn a sanctions argument into a technical security note. A retained note needs a concrete consequence for availability, access, privacy, operation, deployment, or threat exposure.

## 49478894 — islanded generation and environmental impact

I marked this `NOT_MATERIAL` / `REJECTED` because I read the added sentence as an unsupported reaction to a regulatory rule. The phrase “makes no sense” sounded opinion-led, and the comment gives no emissions mechanism, measurement, or source beyond the quoted rule.

Annotator A retained the narrower correction that grid connectivity and environmental impact are different properties. That is a concrete, falsifiable domain relationship even though it is expressed tersely and without a full mechanism.

The general ambiguity is how much explanation a correction needs. Requiring a full mechanism would discard concise expert corrections; accepting every confident objection would admit generic opinion. The useful dividing line is whether the comment states a specific relationship that can stand alone and be checked, rather than merely expressing approval or disbelief.

## 49478431 — app gating and user abandonment

I marked this `NOT_MATERIAL` / `REJECTED` because the comment primarily states conditional personal refusal and broad distrust of apps. It does not report a measured outcome, an actual product incident, a named subject, or an implementation constraint. I therefore treated it as consumer preference rather than substantive product experience.

Annotator A retained an implementation caveat: gating browser-capable functions behind an app can cause a user to abandon the function or site and reduce engagement. That exposes ambiguity between a bare preference and an actionable design consequence stated through first-person behavior.

The general boundary is whether intended behavior is enough for `PRODUCT_EXPERIENCE` or `IMPLEMENTATION_CAVEAT`. A concrete observed action or repeated outcome is stronger than a hypothetical “I will not,” while a design tradeoff needs more than a generalized privacy or trust objection.

## Shared boundary ambiguity

All four rows test the phrase “durable technical value” from a different edge:

- technical processes used inside a legal or moral analogy;
- named technical systems used inside political speculation;
- a terse but falsifiable domain correction;
- a first-person preference framed as a product consequence.

The guide would benefit from separating three tests that are currently blended together:

1. **Specificity:** Does the comment state a concrete relationship, effect, constraint, or observed outcome?
2. **Technical independence:** Does that retained value remain after removing the political, moral, or emotional stance?
3. **Actionability or checkability:** Could a reader apply, investigate, or falsify the extracted claim without reconstructing the surrounding argument?

A row need not pass all three perfectly, but named technologies and confident language should not substitute for them.

## Recommended guide wording before batch 2

Add the following concise boundary rules under material relevance:

> **Technology-policy arguments:** A legal, political, or moral argument is `MATERIAL` only when it contains a specific technical comparison or a concrete consequence for system operation, availability, access, privacy, deployment, or threat exposure. Named technologies used only as examples in a policy argument do not make the comment technical.

> **Terse corrections:** A correction may be `MATERIAL` without a full mechanism when it states a specific, independently checkable relationship. Bare disagreement, ridicule, or “this makes no sense” without such a relationship is `NOT_MATERIAL`.

> **First-person product behavior:** A preference becomes `PRODUCT_EXPERIENCE` or an `IMPLEMENTATION_CAVEAT` only when the comment reports an observed action or outcome, or identifies a concrete and reusable design tradeoff. Conditional refusal and generalized distrust alone are `NOT_MATERIAL`.

> **Rhetorical analogies:** Ignore the surrounding advocacy and extract the proposed comparison. If the comparison still describes a concrete relationship between technical processes, it may be an `EXPERT_NOTE`; if only the policy conclusion remains, reject it as non-technical or generic opinion.

Also clarify the `SECURITY` note type:

> `SECURITY` covers concrete threats, vulnerabilities, controls, risky behavior, or operational exposure. Legal designation, sanctions, or reputational risk without a concrete technical consequence is not a security note.
