**Implementation-plan and classifier failure audit**

Reviewed 2026-09-04 against commit `b856e31` (`Deploy fail-closed production base graph`). This is an engineering assessment and proposed work sequence, not an executed implementation plan. Source code, deployment configuration, plan statuses, and sealed evaluation evidence were left unchanged.

**1. Assessment**

The project has substantial tested backend infrastructure, but its normal operating path does not yet deliver a complete human-reviewed knowledge product. The classifier recovery process has reached a legitimate terminal decision: automatic classification is not approved, and further evaluation cycles are prohibited under the current policy. “Assist-only endpoint adopted” records that decision; it does not establish that production currently generates usable suggestions or supports creating the first decision manually.

“The classifier constantly fails” combines four different situations:

1. Historical evaluation defects distorted early development measurements; several were subsequently corrected.
2. The selected model then genuinely failed the original held-out semantic quality gates, despite valid outputs and successful provider requests.
3. Recovery cycles v2 and v3 stopped at annotation agreement, before model evaluation.
4. The disabled worker deliberately terminates classification jobs with `CLASSIFIER_DISABLED`. This is an operating policy, not a provider outage.

There are also current code defects that need attention before the proposed review workflow can be relied upon: missing materialization wiring, missing first-manual-decision and reviewer-detail/correction paths, invalid outputs that never become review tasks, replay consistency problems, an incomplete request deadline, and a queue dependency that can remain blocked permanently. A separate dormant evaluator defect discards genuine consensus rows in the newer gold format.

**2. What the implementation-plan status means**

The [status table](/Users/p/Projects/hacker-news-indexer/plans/README.md:34) contains ten DONE rows, one BLOCKED row, one IN PROGRESS row, and one TODO row. These counts are not a product-completion percentage: the plans have different sizes, and their component gates do not prove their composition.

| Plans | Recorded state | Engineering interpretation |
| --- | --- | --- |
| 001–002 | DONE | Foundation and deterministic ingestion exist. The documented staging replay resolved 98 canonical comments. This audit did not repeat live ingestion. |
| 003 | BLOCKED | Correct: the original selected model failed its promotion holdout. Implementation and promotion are different deliverables. |
| 003R and 009 | DONE, assist-only | Correct as completion of the pre-registered decision process. They do not certify a successful production suggestion workflow. |
| 004–006 | DONE | Review, materialization, reader, and export components exist. Missing connections and reviewer capabilities prevent treating these statuses as proof of an end-to-end product. |
| 007 | IN PROGRESS | Correct: the recorded production base graph is healthy, but token sealing, live alert work, and bounded ingestion remain outstanding. |
| 008 | TODO | The optional web UI remains unimplemented. Backend review capabilities can be completed without waiting for a frontend. |
| 010–012 | DONE | Relevant fixes are present, including conditional classifier construction, deterministic split sorting, kappa tests, and evaluation crash recovery. New findings below concern remaining gaps. |

The [production rollout record](/Users/p/Projects/hacker-news-indexer/docs/runbooks/reports/2026-09-04-production-base-rollout.md:34) explicitly records both Telegram and classification disabled, with no corresponding provider credentials. It proves a fail-closed deployment smoke at that time. I did not inspect current remote service state.

**3. Failure history, using aggregate evidence only**

Evaluation-cycle numbers, prompt versions, and report generations are separate identifiers. In particular, `holdout-openai-gpt-5-6-sol-low-v3.json` is report generation 3 for **evaluation cycle v1**, not a model run on evaluation cycle v3. Confusing these names makes the history look like repeated failed holdouts when only one model holdout ran.

| Stage | Evidence size | Result | Meaning |
| --- | --- | --- | --- |
| Original development, selected Sol-low / prompt v3 | 69 rows; 65 consensus rows | Stable macro F1, Discovery precision, and Expert-note precision all 1.00 | Passed the selected development gates. |
| Original cycle v1 holdout | 29 rows; 23 consensus rows | Stable macro F1 0.6190; Expert-note precision 0.4000 | Failed required 0.85 / 0.88 quality thresholds. |
| Cycle v2 annotation | 90 rows | Primary-class κ 0.5713; materiality κ 0.5980 | Failed both 0.75 agreement gates; no model evaluation. |
| Excluded calibration batch 1 | 31 rows | Primary κ 0.7606; materiality κ 0.7530 | Passed calibration thresholds. |
| Excluded calibration batch 2 | 31 rows | Primary κ 0.8897; materiality κ 0.8697 | Permitted the one final fresh cycle. |
| Cycle v3 annotation | 90 rows | Primary κ 0.7327; materiality κ 0.7579 | Failed the primary-class gate; no gold finalization, paid development, candidate selection, or holdout opening. |

Sources: [selected development report](/Users/p/Projects/hacker-news-indexer/evaluation/reports/benchmark-openai-gpt-5-6-sol-low-v3.json), [original holdout report](/Users/p/Projects/hacker-news-indexer/evaluation/reports/holdout-openai-gpt-5-6-sol-low-v3.json), [v2 comparison](/Users/p/Projects/hacker-news-indexer/evaluation/reports/annotation-comparison-v2.json), [v3 comparison](/Users/p/Projects/hacker-news-indexer/evaluation/reports/annotation-comparison-v3.json), and [endgame ADR](/Users/p/Projects/hacker-news-indexer/docs/decisions/0006-classifier-endgame.md:31).

The original holdout’s full aggregate confusion matrix was:

| Expected class | Predicted Discovery | Predicted Expert note | Predicted Rejected |
| --- | ---: | ---: | ---: |
| Discovery | 2 | 2 | 1 |
| Expert note | 0 | 6 | 0 |
| Rejected | 0 | 7 | 11 |

The model produced 15 Expert-note predictions, of which only six were correct: nine false positives, or 60% of the predicted notes. It recovered only two of five Discoveries. On the consensus-only slice, five rejected comments became Expert notes, one Discovery became an Expert note, and one Discovery was rejected.

This was not a JSON, authentication, or general provider-availability failure: the holdout recorded 29 terminal runs for 29 rows, an empty provider-failure map, schema/application validity of 1.00, zero invented URLs, valid evidence spans, and p95 latency of 7.992 seconds. It also recorded zero model review routing and three missed expected review cases. “Automatic coverage 1.00” in this historical report describes the model’s willingness to decide; actual activated decisions were zero.

The [provider ADR](/Users/p/Projects/hacker-news-indexer/docs/decisions/0005-classifier-provider.md:31) documents earlier evaluation problems: missing rubric content, treatment of review abstentions, positional discovery matching, conflation of schema and application validity, non-unique evidence-origin choices, and development labels previously overridden to match historical totals. Those issues explain why early scores should not be compared as if every report measured the same instrument. Their correction does not erase the subsequent genuine holdout failure.

The later annotation results show that a reliable reference-labeling process was not established at the chosen threshold. They do not show that Sol failed twice more, prove a provider capability ceiling, or identify a particular annotator as the cause. The aggregate reports do not support a row-level causal diagnosis. Calibration on two small excluded batches improved agreement, but did not guarantee agreement on the next 90 comments. V3 missed its primary-class gate by approximately 0.0173; that is still a failure under the unchanged pre-registration.

**4. Prioritized implementation findings**

Effort: S = hours, M = roughly a day, L = several days, including tests. Risk describes the proposed change, not the severity of the existing behavior. Estimates are approximate. All findings below have HIGH confidence in the cited code behavior; their involvement in a particular live incident is unverified unless explicitly stated.

| ID | Finding | Category | Priority / applicability | Effort | Change risk |
| --- | --- | --- | --- | --- | --- |
| F1 | Resolved comments cannot receive a first human decision with the provider disabled | Product/workflow | P1, current operating model | L | MED |
| F2 | Normal classification never materializes feed objects | Correctness | P1, required workflow connection | M | MED |
| F3 | Review API lacks pending proposal details and extraction corrections | Product/contracts | P1, permanent human-review model | M–L | MED |
| F4 | Invalid output is stored as REVIEW without opening a review task | Correctness | P1 before assisted execution | M | MED |
| F5 | Replayed work can attach a new decision to an older provider result | Integrity/idempotency | P1 before assisted execution | M–L | MED |
| F6 | A terminal resolver blocks sibling classification jobs indefinitely | Queue correctness | P1 for bounded ingestion | M | MED |
| F7 | New gold metadata is incompatible with evaluator consensus selection | Evaluation correctness | P1 prerequisite to any separately authorized future evaluation; dormant now | M | LOW–MED |
| F8 | Request deadline ends before body consumption; timeout setting is unused | Runtime/configuration | P2 before assisted execution | S–M | LOW |
| F9 | Guide and executable plans contradict their schemas or terminal policy | Documentation/instrument | P2; inexpensive first cleanup | S | LOW |
| F10 | Existing verification does not prove a nonempty product workflow | Test coverage | P1, accompanies F1–F6 | M | LOW |

**F1 — The adopted operating model has no first manual decision path.**

Resolution [always enqueues classification](/Users/p/Projects/hacker-news-indexer/packages/application/src/resolve-hn/resolve-selected-comment.ts:146). With classification disabled, the [handler exits immediately](/Users/p/Projects/hacker-news-indexer/apps/worker/src/jobs/classify.ts:31), before creating a run, decision, or review task. A manual decision [must override an existing decision](/Users/p/Projects/hacker-news-indexer/packages/db/src/repositories/classification.ts:325), and the [database constraint enforces that restriction](/Users/p/Projects/hacker-news-indexer/packages/db/prisma/migrations/0003_classification/migration.sql:50).

Consequently, a newly resolved comment cannot enter the supported human-review workflow from scratch. It can be available as canonical source text, but cannot become retained, approved knowledge through the current application path. Simply ingesting more content or completing deployment does not address this.

Proposed work: add an authenticated inbox of undecided resolved comments and a validated initial human-decision command. Represent initial human authorship separately from an override, preserve the source revision and evidence, and retain explicit publication approval. This follows the current no-provider operating policy. Do not change `CLASSIFIER_ENABLED` as a shortcut.

**F2 — Materialization exists only in a special helper, not the normal workflow.**

The classifier [saves a decision and opens review](/Users/p/Projects/hacker-news-indexer/packages/application/src/classification/classify.ts:264), then returns. The worker [uses the result for error metrics only](/Users/p/Projects/hacker-news-indexer/apps/worker/src/jobs/classify.ts:51). The only non-test caller of `createMaterializeClassification` is the [seed shadow script](/Users/p/Projects/hacker-news-indexer/scripts/materialize-seed-shadow.mts:278), which explicitly invokes materialization after classification.

Review approval [activates the decision and updates existing objects](/Users/p/Projects/hacker-news-indexer/packages/db/src/repositories/review.ts:640). It does not create absent Discoveries or Expert notes. A normal worker-produced proposal can therefore be approved while yielding zero feed objects.

Proposed work: connect decision persistence to idempotent materialization of pending objects, with a durable recovery path. Expose a ready-to-approve task only after its pending objects are consistent, or make approval verify that prerequisite. Reuse this workflow for initial manual decisions and any later authorized model assistance. Preserve zero visibility before approval.

**F3 — A reviewer cannot inspect and correct the proposal through the supported API.**

The [review response](/Users/p/Projects/hacker-news-indexer/apps/api/src/routes/review.ts:144) exposes task metadata, not the proposed class, extraction, evidence, or candidate URLs. The [available actions](/Users/p/Projects/hacker-news-indexer/apps/api/src/routes/review.ts:281) approve, reject, merge subjects, or resolve URLs; they do not edit a class, title, summary, or evidence selection. The [reader’s comment endpoint](/Users/p/Projects/hacker-news-indexer/packages/application/src/reader/knowledge-reader.ts:381) exposes source content, but its attached items are drawn from published content, not the pending proposal.

This falls short of the [human correction path promised by Plan 004](/Users/p/Projects/hacker-news-indexer/plans/004-implement-subjects-and-review.md:30). A reviewer should not need database access to discover what they are approving.

Proposed work: add a private pending-task detail contract and a versioned correction action. Return bounded structured proposals and source evidence, not raw provider payloads. Corrections should create a new audited manual decision and supersede the prior proposal, preserving optimistic concurrency and idempotency. A full frontend is not necessary for this backend capability.

**F4 — An invalid result becomes a REVIEW run but never reaches the review queue.**

After validation fails, the [invalid-output branch](/Users/p/Projects/hacker-news-indexer/packages/application/src/classification/classify.ts:200) writes a REVIEW run and returns. It does not call `saveDecision` or `openPolicyReview`; that [review call exists only in the valid-output branch](/Users/p/Projects/hacker-news-indexer/packages/application/src/classification/classify.ts:285). The worker completes the job normally. This conflicts with the intended “evidence mismatch → reject extraction and enqueue review” behavior in the [research plan](/Users/p/Projects/hacker-news-indexer/docs/telegram-hn-technical-knowledge-project-research-plan.md:655).

Offline reproduction with two invalid JSON responses: `kind=REVIEW`, one REVIEW run, zero saved decisions, and zero review-service calls despite a wired review service. The rejected extraction stays unpublished, but the human recovery work is invisible in the normal queue.

Proposed work: introduce a reviewable failure entity associated with the comment/run, or a minimal safe review decision that contains no invalid extraction. Make task creation recoverable and idempotent. Test invalid JSON after the allowed retry, schema errors, unknown evidence, and unsupported URLs. Keep invalid provider claims out of accepted content.

**F5 — Persistence idempotency happens after the paid request and can mix attempts.**

The application [calls the provider before persisting the run](/Users/p/Projects/hacker-news-indexer/packages/application/src/classification/classify.ts:148). On duplicate identity, the [repository returns the previously recorded run with `created: false`](/Users/p/Projects/hacker-news-indexer/packages/db/src/repositories/classification.ts:267). Its identity check [compares prompt/provider/model metadata, not the output](/Users/p/Projects/hacker-news-indexer/packages/db/src/repositories/classification.ts:154). The application ignores `created` and proceeds with the newest output when saving a decision.

Offline reproduction used the real repository factory with an injected database client: interrupt after the first run is recorded, then replay. Two provider calls occurred. The persisted run retained the first output, while the new decision contained the second output. Thus a crash between run and decision persistence can produce inconsistent audit provenance. If a decision already exists, replay can similarly return that older decision alongside the newer in-memory output.

Proposed work: establish a durable logical execution identity before calling the provider; resume from a stored result when appropriate, and derive the decision from exactly that result. Model explicit attempts where retry is intended. Make persistence, materialization, and review creation resumable without mixing attempts. This also supports the already-deferred [worker lease-loss cancellation work](/Users/p/Projects/hacker-news-indexer/plans/README.md:95). This defect was reproduced offline; it is not evidence that the historical benchmark runs were corrupted.

**F6 — A permanently failed resolver can leave an ingestion run permanently RUNNING.**

The [queue claim query](/Users/p/Projects/hacker-news-indexer/packages/db/src/job-queue.ts:223) blocks every classification job in a run while any resolver in that run has a state other than COMPLETED. TERMINAL is included. Successfully resolved comments already have classification jobs. If a sibling resolver exhausts retries, those jobs remain AVAILABLE but unclaimable. [Run reconciliation](/Users/p/Projects/hacker-news-indexer/packages/db/src/repositories/ingestion-runs.ts:180) counts AVAILABLE jobs as active and therefore retains RUNNING status.

Proposed work: define explicit dependency-failure handling. Once prerequisites have settled, allow independently resolved comments to proceed and terminalize or otherwise account for impossible work. Preserve any necessary batch-ordering guarantees. Add an integration test with two comments, one permanently failed resolver, and one successful resolver; prove the run reaches a documented terminal/partial state with no stranded runnable work. This is a source-confirmed reachable path, not a reproduced database incident.

**F7 — The evaluator misunderstands the newer gold format.**

The [gold finalizer](/Users/p/Projects/hacker-news-indexer/packages/application/src/classification/annotation-adjudication.ts:415) emits `materialRelevanceDisagreement` and `primaryClassDisagreement`, with a [new fixed consensus rationale](/Users/p/Projects/hacker-news-indexer/packages/application/src/classification/annotation-adjudication.ts:17). The evaluator’s [local row type](/Users/p/Projects/hacker-news-indexer/scripts/evaluate-classifier.mts:108) still expects a single `disagreement` field, and [consensus selection](/Users/p/Projects/hacker-news-indexer/scripts/evaluate-classifier.mts:934) depends on equality to the old rationale string.

An in-memory probe using the actual helper source and fabricated `gold.v2` metadata classified both a genuine consensus row and an ordinary adjudicated row as `CONSENSUS_OVERRIDDEN`. Genuine new-format consensus rows are discarded from [the stable-gold slice](/Users/p/Projects/hacker-news-indexer/scripts/evaluate-classifier.mts:963). With no remaining stable rows, the resulting macro F1 and class precisions are zero, failing [the hard gates](/Users/p/Projects/hacker-news-indexer/scripts/evaluate-classifier.mts:1287). Conversely, an adjudicator copying the exact legacy rationale could accidentally be recognized as consensus. Prose equality is not a sound data contract.

Proposed work: parse gold through a versioned shared contract, derive agreement from explicit metadata, and reject unsupported or unusable gold before any provider request. Test the finalizer-to-evaluator boundary using synthetic rows. Preserve historical report semantics and artifacts. This defect did **not** cause v2 or v3 to fail: both stopped before gold creation. Repairing it would not authorize a new cycle or invalidate the assist-only decision.

**F8 — The advertised request timeout does not cover the response body.**

The adapter [clears its timer as soon as fetch returns](/Users/p/Projects/hacker-news-indexer/packages/adapters/src/classifier/openai.ts:273), then [awaits `response.json()`](/Users/p/Projects/hacker-news-indexer/packages/adapters/src/classifier/openai.ts:279) outside the deadline. An injected response with a 10 ms request budget and an 80 ms delayed body completed after approximately 91 ms; the abort signal never fired. A body that stalls can occupy a worker slot beyond the advertised deadline.

Additionally, [configuration exposes `CLASSIFIER_REQUEST_TIMEOUT_MS`](/Users/p/Projects/hacker-news-indexer/packages/config/src/env.ts:102), but the application [always passes its fixed 45,000 ms constant](/Users/p/Projects/hacker-news-indexer/packages/application/src/classification/classify.ts:143). Changing the environment setting does not change the execution deadline.

Proposed work: keep cancellation active through complete response consumption and map deadline expiry consistently to the retryable timeout outcome. Either wire the configured deadline through execution or remove the misleading setting while retaining the documented fixed limit. Test delayed headers and delayed bodies separately. The historical holdout’s latency evidence does not implicate this defect in its semantic failure.

**F9 — The guide and current execution instructions contain actionable contradictions.**

The [annotation guide’s worked REVIEW example](/Users/p/Projects/hacker-news-indexer/docs/annotation-guide.md:79) assigns primary class REVIEW for a policy-sensitive recommendation. The [annotation pass schema](/Users/p/Projects/hacker-news-indexer/evaluation/annotation-pass-schema-v2.json:26) permits only DISCOVERY, EXPERT_NOTE, or REJECTED. The [guide’s later fresh-cycle instructions](/Users/p/Projects/hacker-news-indexer/docs/annotation-guide.md:226) also require those three classes. Meanwhile the [current model prompt](/Users/p/Projects/hacker-news-indexer/packages/application/src/classification/prompt.ts:15) explicitly keeps classifiable content separate from policy review. This is a concrete inconsistency in the labeling instrument, though the aggregate evidence cannot show how much it affected either failed pass.

Separately, [evaluation/README.md still describes v3 as SPLIT_FROZEN and awaiting annotation](/Users/p/Projects/hacker-news-indexer/evaluation/README.md:52), followed by commands to continue that process. The [endgame ADR](/Users/p/Projects/hacker-news-indexer/docs/decisions/0006-classifier-endgame.md:62) records the opposite terminal state and forbids continuation. [Plan 007’s preflight](/Users/p/Projects/hacker-news-indexer/plans/007-harden-and-deploy-railway.md:5) and [unconditional red-gate STOP condition](/Users/p/Projects/hacker-news-indexer/plans/007-harden-and-deploy-railway.md:384) conflict with its [explicit classifier-excluded release alternative](/Users/p/Projects/hacker-news-indexer/plans/007-harden-and-deploy-railway.md:324).

Proposed work: make the terminal state prominent, label old workflow commands as historical, and reconcile current execution gates without changing failed results. Document the annotation-guide contradiction as historical instrument debt; any current reviewer guide should distinguish content class from review disposition. Do not rewrite failed annotations, tune from their rows, or reopen evaluation to resolve this documentation issue.

**F10 — Green tests and release scripts do not establish a usable composed workflow.**

The [pipeline benchmark](/Users/p/Projects/hacker-news-indexer/scripts/benchmark-pipeline.mts:55) loads and validates existing decisions. It does not time the worker-to-review-to-feed path. Missing decisions are deferred; [passing requires only one completed case](/Users/p/Projects/hacker-news-indexer/scripts/benchmark-pipeline.mts:105), no validation failures, and the latency threshold. The [feed audit’s safety gates](/Users/p/Projects/hacker-news-indexer/scripts/audit-feed.mts:119) can all pass for an empty feed. The [release script](/Users/p/Projects/hacker-news-indexer/scripts/release-verify.sh:34) prepares state through the special seed materialization helper before those checks.

These are useful component and negative-safety checks. They leave the missing positive workflow untested. Existing [review integration fixtures](/Users/p/Projects/hacker-news-indexer/tests/integration/review-workflow.test.ts:70) directly create prerequisite runs and decisions, which also bypasses the missing initial human-decision path.

Proposed work: add one explicit nonempty journey through real application boundaries, with synthetic content and no paid provider: resolved source → initial human decision → pending materialization → proposal inspection/correction → approval → expected feed item. Test rejected/unapproved invisibility, replay, source changes, and later retraction. Add a separate explicitly approved export path for eligible Discoveries; Expert notes remain nonexportable. Require expected completion counts instead of accepting partial coverage silently.

**5. What the architecture proves, and what it does not**

The deterministic validators are valuable: bounded input, known URL candidates, known evidence-span IDs, evidence-origin consistency, and supported subject surface names reduce structural and provenance errors. They cannot establish that every fluent summary is entailed by its citation, that a technically valid comment deserves retention, or that a model’s stated confidence is calibrated. Perfect schema/span results therefore coexist with poor class precision without contradiction.

The current [v4 prompt](/Users/p/Projects/hacker-news-indexer/packages/application/src/classification/prompt.ts:5) asks for materiality followed by retained-class extraction. This remains one provider request. The [deterministic router](/Users/p/Projects/hacker-news-indexer/packages/application/src/classification/decision-router.ts:102) checks field consistency and derives review reasons; it is not an independently evaluated second classifier. There is no paid quality result for this current compatibility set. Historical prompt-v3 success cannot be inherited by it.

The consensus-only scoring policy is documented and intentional. Its practical limitation is sample size and representativeness: the selected development slice had only seven Discovery rows and 20 Expert-note rows; the stable holdout had three and four respectively. Perfect development precision on those counts provides limited assurance about future content. Excluding disputed rows also narrows the population for which the hard quality claim would apply. These limitations are reasons to preserve human review, not reasons to retroactively weaken the acceptance gates.

The [seed review-load report](/Users/p/Projects/hacker-news-indexer/evaluation/reports/review-load-seed-v1.json) records 104 open tasks for 98 comments, including 98 content reviews and six URL-resolution tasks. That is approximately 1.06 tasks per comment, with every comment requiring review. It is fixture workload evidence, not observed reviewer productivity. An assist-only product should eventually measure human minutes per accepted item, correction rate, useful-item yield, and queue age; the current record does not establish that assistance saves time.

**6. Recommended next work under the existing terminal decision**

1. Reconcile the status documents and define a concrete manual-product acceptance scenario. Keep the v1/v2/v3 failures visible and immutable. Describe 003R/009 as decision-process completion; do not imply classifier promotion or live suggestions.
2. Implement F1 and F3 together: an undecided-content inbox, initial human decisions, pending proposal details, and audited corrections. This creates value while the provider remains disabled.
3. Connect materialization and review readiness (F2), then add the nonempty application-boundary integration scenario (F10). A manually approved item must actually become readable, with exact expected object counts and no duplicate objects on replay.
4. Repair queue terminal-dependency handling (F6). For any later assisted execution, require F4, F5, and F8 first: visible failures, consistent resumable persistence, and effective deadlines.
5. Complete Plan 007’s documented operational follow-ups under its existing authorization process, using the working manual journey as the product smoke. Healthy processes alone are insufficient acceptance.
6. Treat F7 as dormant evaluation maintenance. If that machinery is retained, add a synthetic contract test and repair it independently of historical evidence. It is outside the current product critical path and grants no permission for paid runs or another cycle.

No immediate model switch, reasoning-effort increase, fine-tuning, lower kappa threshold, or new holdout follows from these findings. The existing terminal policy already decides those questions for this release. The highest-value next work is closing the human workflow and proving that it produces useful retained content.

**7. Verification performed and limits**

| Check | Result |
| --- | --- |
| `npm test` | 236 tests passed across 33 files. |
| Evaluation regressions via `npm exec -- vitest run --config vitest.evaluation.config.ts` | 42 tests passed across five files. |
| `npm run test:contract -- --target findthatproject --dry-run` | Two tests passed; HN and Telegram live tests skipped. |
| `npm run lint` | Passed. |
| `npm run evaluation:validate-cycles` | Passed: v1 OPENED_FAILED, v2 ANNOTATION_FAILED, v3 ANNOTATION_FAILED; pinned artifact digests validated. |
| Offline injected-dependency probes | Reproduced missing review-task creation, uncovered response-body deadline, and replayed run/decision output mismatch. |
| Synthetic evaluator-helper probe | Reproduced misclassification of new gold metadata and zero-valued metrics for an empty stable slice. |

The unit, evaluation, contract, and runtime reproduction checks used installed Node 24.18.0; the repository pins 24.19.0, which was not installed locally. Initial runs under the default Node 25.6.1 encountered sandbox restrictions on local HTTP/IPC sockets. Reruns outside the sandbox under Node 24 passed; those initial failures are not reported as repository defects. Lint and the cycle-integrity validator completed under the default runtime.

The full `npm run test:evaluation` wrapper was not run because it rebuilds source/replay artifacts. The underlying regression suite and read-only integrity validator were run instead. No dependency reinstall, generated build, database reset, migration, Docker release gate, live provider call, or remote deployment check was performed during this read-only audit. The repository’s full global verification gate remains required for a future implementation plan.

Scope covered the implementation/status plans, research requirements relevant to classification and review, ADRs, classifier application/adapter/persistence paths, queue prerequisites, review and materialization connections, evaluation metadata/scoring, and relevant tests and operational records. It was not a complete security/dependency audit, a current cloud-state audit, a performance benchmark, or a revalidation of every unrelated reader/export implementation detail. Failed annotation rows and sealed source/holdout contents were not inspected for diagnosis or tuning; model-result review used aggregate report fields only.

Considered and rejected as current findings: the old unconditional-null classifier construction is fixed; explicit nonactivation and review requirements are intended safeguards; kappa computation has nontrivial tests and no formula defect was found; perfect fixture replay is pipeline evidence rather than a model-quality claim. Previously deferred pagination, export batching, and broad refactors remain outside this report’s proposed first work.
