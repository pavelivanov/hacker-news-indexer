# Excluded classifier calibration

These calibration rows are permanently excluded from numbered evaluation
cycles. They exist only to test and clarify the human annotation rubric. Do
not pass any file in this directory to `evaluation:prepare-cycle`, and do not
copy these rows into a later cycle source.

The public-channel capture command enforces a 90-message minimum. At capture
time only 62 messages existed after the terminal v2 window, so the transport
capture covers `33010..33099` and the already-used prefix `33010..33037` is
ignored. Only the fresh messages `33038..33099` enter calibration:

- `v1`: messages `33038..33068`, 31 unique canonical HN comments.
- `v2`: messages `33069..33099`, 31 unique canonical HN comments.

A future v3 capture must start at Telegram message `33100` or later. The
`v9001` and `v9002` values inside packet/pass rows are schema-compatible
annotation namespaces only; there are no corresponding cycle manifests and
they must never be created.

`harness.mjs` uses the production annotation packet, pass parser, and κ
comparison functions without changing cycle tooling. Its comparison reports
contain labels and IDs but no comment or root text.

Batch 2 passed both pre-registered gates, so the selected path is a fresh v3
cycle rather than the assist-only endpoint. At the 2026-08-31 readiness check,
the public channel had reached only message `33102`; the required 90-message
post-calibration window therefore did not yet exist. No v3 cycle was opened.
