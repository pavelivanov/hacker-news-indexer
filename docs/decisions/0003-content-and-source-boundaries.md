# ADR 0003: Content and source boundaries

- Status: accepted
- Date: 2026-08-24

## Decision

Telegram `@hn_best_comments` is the default selection source and provenance occurrence. The selected Hacker News comment is canonical content. The root HN story is bounded supporting context. A direct HN `/bestcomments` source may be added later behind the same selection-source port.

Resolution may walk only the selected item's parent chain to its root. It must never traverse sibling comments or fetch arbitrary external pages in v1. Displayed Telegram story IDs remain provenance and must not override the resolved HN root.

## Consequences

Telegram messages, canonical selected comments, and root stories are separate identities. Classification, ranking, and deduplication operate on canonical comments rather than Telegram messages. All extracted URLs must come from supplied candidates, and every claim requires validated evidence.
