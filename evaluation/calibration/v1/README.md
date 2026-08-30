# Calibration batch 1

This permanently excluded batch contains the 31 unique canonical comments
selected by Telegram messages `33038..33068`. Annotators A and B receive only
their own shuffled packet, `docs/annotation-guide.md`, and
`evaluation/annotation-pass-schema-v2.json`; they do not receive the other
pass, model output, historical totals, numbered-cycle manifests, or holdout
assignments.

After both independent passes are validated and compared, the annotators may
discuss this batch and propose guide clarifications. None of these rows may
enter a numbered evaluation cycle.

## Result

Both 31-row passes validated with the production parser. The body-free
comparison in `comparison.json` records primary-class κ `0.7606177606177605`
and material-relevance κ `0.7529880478087649`, with 27 exact decision
agreements. The four disagreements were discussed in `discussion-a.md` and
`discussion-b.md`; their consensus produced the dated calibration
clarification in `docs/annotation-guide.md` before batch 2 began.
