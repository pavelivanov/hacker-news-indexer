# Batch 1 calibration discussion — Annotator A

This memo discusses the four batch-1 disagreements. It does not revise either annotation pass.

## Comment 49487533

**A:** `MATERIAL` / `EXPERT_NOTE` (`COMPARISON`)

**B:** `NOT_MATERIAL` / `REJECTED` (`GENERIC_OPINION`)

I treated the comment's book-to-model versus model-to-model analogy as a reusable comparison: if “transformative” use justifies training on books, the commenter argues that the same principle should apply to model distillation. The argument remains understandable outside the thread and identifies a tension between two positions.

The weakness in my decision is that the retained value is legal and normative, not technical. The comment does not explain either transformation, identify an implementation consequence, or report a bounded operational fact. I implicitly used “coherent and reusable argument” as the threshold, while B used the guide's narrower “reusable technical value” threshold.

**Boundary exposed:** technology-adjacent legal reasoning versus a technical comparison. Mentioning model training and distillation is not enough when the only retained claim concerns consistency or fairness.

## Comment 49478826

**A:** `UNCERTAIN` / `EXPERT_NOTE` (`SECURITY`)

**B:** `NOT_MATERIAL` / `REJECTED` (`NON_TECHNICAL`)

I saw a potentially reusable ecosystem-risk observation: sanctioning an infrastructure provider because of a user's conduct could expose users and developers of I2P, Monero, Veilid, Tox, or Signal to similar treatment. I used `UNCERTAIN` because the comment names security- and privacy-related systems but expresses the claimed risk through rhetorical legal-policy questions rather than a confirmed technical effect.

B's decision reflects the stronger reading of the materiality rule. The comment gives no threat model, vulnerability, control, system behavior, or technical consequence. The named systems illustrate a political and legal concern; they do not make the concern technical.

**Boundary exposed:** a security observation must concern technical security properties or practices, not merely adverse legal treatment of security-related infrastructure.

## Comment 49478894

**A:** `MATERIAL` / `EXPERT_NOTE` (`CORRECTION`)

**B:** `NOT_MATERIAL` / `REJECTED` (`GENERIC_OPINION`)

I treated the combination of a specific quoted regulatory exception and the claim that grid connection is unrelated to environmental impact as a correction. The statement is concrete and directly contests the rationale implied by the exception.

The counterargument is only asserted. The comment does not explain emissions, operating mode, load, fuel, or another mechanism showing why islanding is environmentally irrelevant. Much of the concrete detail is quoted source material rather than information added by the commenter. B therefore treated the added content as a bare evaluative reaction.

**Boundary exposed:** a correction needs commenter-added counterevidence or technical rationale. Quoting a precise source claim does not by itself make a following unsupported contradiction material.

## Comment 49478431

**A:** `MATERIAL` / `EXPERT_NOTE` (`IMPLEMENTATION_CAVEAT`)

**B:** `NOT_MATERIAL` / `REJECTED` (`GENERIC_OPINION`)

I read the comment as a product-design caveat: forcing browser-capable functions behind an app can cause abandonment, reduce engagement metrics, and trigger privacy or security distrust. That is a plausible tradeoff for teams deciding whether to app-gate features.

The comment, however, reports intended personal behavior rather than an observed product outcome, reproducible constraint, measured effect, or substantive first-hand use of a named product. Turning one user's refusal into a general implementation consequence adds an inference that the source does not establish. B kept it on the generic-opinion side.

**Boundary exposed:** substantive product experience versus consumer preference. A stated intention or hypothetical reaction is not an observed product result.

## General ambiguity

All four disagreements came from compressing a coherent opinion into an expert-note-shaped summary. The current guide lists eligible note types, but it does not state strongly enough that the comment itself must add a concrete technical element. A technical noun, a precise quotation, or a plausible downstream consequence can make a summary sound useful even when the underlying contribution is legal argument, political concern, unsupported contradiction, or personal preference.

For batch 2, I recommend requiring at least one commenter-added element that survives extraction: a mechanism, implementation effect, observed or measured behavior, operational constraint, reproducible comparison, concrete counterfact, or bounded remedy. Review flags should be applied only after materiality is decided; a legal or security topic does not upgrade non-technical commentary into material content.

## Recommended guide wording

Add under **Materiality boundary**:

> A named technical subject does not make adjacent legal, political, policy, or consumer commentary material. The selected comment must itself add a concrete reusable technical element: a mechanism, implementation effect, observed or measured behavior, operational constraint, reproducible comparison, counterfact with technical rationale, or bounded remedy. A quoted premise followed only by an unsupported evaluation, a rhetorical policy hypothetical, or a statement of intended personal behavior is `NOT_MATERIAL`.

Add under **Expert-note types**:

> `SECURITY` requires a technical threat, vulnerability, control, risky behavior, or operational security consequence. Legal, political, or reputational risk to users or developers is not a security note without such a technical element.
>
> `CORRECTION` must add counterevidence, a concrete counterfact, or an explanatory technical rationale. A bare contradiction or “this makes no sense” reaction is `GENERIC_OPINION`, even when it follows a precise quotation.
>
> `PRODUCT_EXPERIENCE` requires actual use plus a substantive observed outcome, constraint, or tradeoff. A preference, refusal, or hypothetical future response without an observed product result is `GENERIC_OPINION`.

Add under **Review reasons**:

> Decide materiality before applying legal, medical, or security review gates. A gate routes an otherwise material result to review; it does not make non-technical commentary material.
