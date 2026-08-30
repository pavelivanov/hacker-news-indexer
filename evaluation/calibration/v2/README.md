# Calibration batch 2

This permanently excluded batch contains the 31 unique canonical comments
selected by Telegram messages `33069..33099`. Annotators A and B receive only
their own shuffled packet, the post-discussion annotation guide, and
`evaluation/annotation-pass-schema-v2.json`. They must label independently,
with no discussion or pass sharing until both files are complete.

The pre-registered endgame rule is applied to this batch's two κ values. None
of these rows may enter a numbered evaluation cycle.

## Result

Both 31-row passes validated with the production parser. The body-free
comparison in `comparison.json` records primary-class κ `0.889679715302491`
and material-relevance κ `0.8697478991596638`, with 29 exact decision
agreements. Both values exceed the pre-registered `0.75` threshold, so the
decision rule selects a fresh v3 evaluation cycle and rejects the assist-only
fallback at this decision point.

V3 must start at Telegram message `33100` or later and requires 90–150 fresh
messages. The channel was only at `33102` on 2026-08-31, so no compliant v3
capture existed and no numbered cycle was opened.
