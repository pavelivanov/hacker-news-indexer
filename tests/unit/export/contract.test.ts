import { describe, expect, it } from "vitest";

import { isFindThatProjectDiscoveryV1 } from "@hn-knowledge/contracts";

const payload = {
  schema_version: "findthatproject.discovery.v1",
  export_id: "00000000-0000-4000-8000-000000000001",
  revision: 1,
  action: "UPSERT",
  discovery_id: "00000000-0000-4000-8000-000000000002",
  kind: "DISCOVERY",
  subject: {
    name: "Hister",
    type: "PROJECT",
    canonical_url: "https://github.com/asciimoo/hister",
    evidence_based_summary: "Personal full-text and semantic search index",
  },
  provenance: {
    hn_comment_id: 49402473,
    hn_root_story_id: 49351802,
    telegram_message_ids: [32944],
    evidence_origin: "COMMENT",
    evidence_quote: "A bounded excerpt grounded in the selected HN comment.",
  },
  confidence: 0.98,
  reviewed_at: "2026-08-26T12:00:00.000Z",
} as const;

describe("findthatproject.discovery.v1 contract", () => {
  it("accepts the approved research example shape", () => {
    expect(isFindThatProjectDiscoveryV1(payload)).toBe(true);
  });

  it.each([
    ["unknown field", { ...payload, provider_output: {} }],
    [
      "non-HTTP URL",
      {
        ...payload,
        subject: { ...payload.subject, canonical_url: "file:///x" },
      },
    ],
    ["missing provenance", { ...payload, provenance: undefined }],
    [
      "missing evidence",
      { ...payload, provenance: { ...payload.provenance, evidence_quote: "" } },
    ],
    ["expert note", { ...payload, kind: "EXPERT_NOTE" }],
  ])("rejects %s", (_name, candidate) => {
    expect(isFindThatProjectDiscoveryV1(candidate)).toBe(false);
  });

  it("accepts a bounded immutable retraction revision", () => {
    expect(
      isFindThatProjectDiscoveryV1({
        schema_version: "findthatproject.discovery.v1",
        export_id: payload.export_id,
        revision: 2,
        action: "RETRACT",
        discovery_id: payload.discovery_id,
        kind: "DISCOVERY",
        retraction_reason: "CONTENT_UNAVAILABLE",
        provenance: {
          hn_comment_id: 49402473,
          hn_root_story_id: 49351802,
          telegram_message_ids: [32944],
        },
        reviewed_at: "2026-08-26T13:00:00.000Z",
      }),
    ).toBe(true);
  });
});
