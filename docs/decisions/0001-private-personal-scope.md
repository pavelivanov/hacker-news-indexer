# ADR 0001: Private personal-use scope

- Status: accepted
- Date: 2026-08-24

## Decision

The first release is a private, single-user research tool. It will not provide public signup, third-party access, monetization, or multi-user features. Legal or source-platform permission approval is not a Phase 0 blocker under the owner's personal-use decision, so the project will not add a legal approval checklist.

## Consequences

Authentication and deployment may assume one owner, while still protecting every endpoint and secret. The scope decision must be reconsidered before any public, commercial, shared, or multi-user deployment, including a fresh review of Telegram's API and content-use terms.
