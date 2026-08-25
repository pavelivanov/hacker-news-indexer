import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  compareSubjectIdentities,
  createSubjectIdentity,
  hnItemId,
  normalizeSubjectUrl,
  type SubjectIdentityInput,
} from "@hn-knowledge/domain";

const hasher = {
  sha256: (value: string): string =>
    createHash("sha256").update(value).digest("hex"),
};

const identity = (overrides: Partial<SubjectIdentityInput> = {}) =>
  createSubjectIdentity(
    {
      name: "Fixture",
      aliases: [],
      subjectType: "PROJECT",
      canonicalUrl: null,
      verifiedOfficialDomain: null,
      disambiguatingRootId: null,
      provenanceKey: "comment:1",
      ...overrides,
    },
    hasher,
  );

describe("subject URL policy", () => {
  it("normalizes only supplied HTTP(S) URLs and removes allowlisted tracking", () => {
    expect(
      normalizeSubjectUrl(
        "HTTPS://Example.COM:443/path?keep=1&utm_source=hn&KeepCase=yes#section",
      ),
    ).toEqual({
      ok: true,
      value: {
        rawUrl:
          "HTTPS://Example.COM:443/path?keep=1&utm_source=hn&KeepCase=yes#section",
        canonicalUrl: "https://example.com/path?keep=1&KeepCase=yes",
        scheme: "https",
        host: "example.com",
      },
    });
  });

  it.each([
    ["/relative", "RELATIVE"],
    ["javascript:alert(1)", "UNSUPPORTED_SCHEME"],
    ["https://user:secret@example.com/", "CREDENTIALS_PRESENT"],
  ] as const)("rejects %s", (rawUrl, code) => {
    expect(normalizeSubjectUrl(rawUrl)).toEqual({ ok: false, code });
  });
});

describe("subject identity policy", () => {
  it("merges exact ecosystem coordinates before URL paths", () => {
    const canonical = identity({
      name: "Ratatui",
      canonicalUrl: "https://github.com/ratatui/ratatui",
    });
    const issue = identity({
      name: "Ratatui",
      canonicalUrl: "https://github.com/ratatui/ratatui/issues/1",
      provenanceKey: "comment:2",
    });

    expect(compareSubjectIdentities(canonical, issue)).toEqual({
      kind: "AUTO_MERGE",
      basis: "ECOSYSTEM_COORDINATE",
    });
  });

  it("merges exact canonical URLs and root-scoped repetitions", () => {
    const first = identity({
      name: "NickelMenu",
      canonicalUrl: "https://nickelmenu.example/docs",
    });
    const replay = identity({
      name: "NickelMenu",
      canonicalUrl: "https://NICKELMENU.example:443/docs#install",
      provenanceKey: "comment:2",
    });
    const rootOnlyA = identity({
      name: "Plato",
      disambiguatingRootId: hnItemId(100),
      provenanceKey: "comment:3",
    });
    const rootOnlyB = identity({
      name: "Plato",
      disambiguatingRootId: hnItemId(100),
      provenanceKey: "comment:4",
    });

    expect(compareSubjectIdentities(first, replay).kind).toBe("AUTO_MERGE");
    expect(compareSubjectIdentities(rootOnlyA, rootOnlyB)).toEqual({
      kind: "AUTO_MERGE",
      basis: "NAME_CONTEXT",
    });
  });

  it("routes name-only similarity to review and keeps homonyms separate", () => {
    const historical = identity({
      name: "15.ai",
      aliases: ["15ai"],
      provenanceKey: "root:historical",
    });
    const nameOnly = identity({
      name: "15ai",
      provenanceKey: "root:new",
    });
    const firstDomain = identity({
      name: "Plato",
      canonicalUrl: "https://plato-one.example/",
    });
    const otherDomain = identity({
      name: "Plato",
      canonicalUrl: "https://plato-two.example/",
    });

    expect(compareSubjectIdentities(historical, nameOnly)).toEqual({
      kind: "REVIEW",
      basis: "NAME_ONLY",
    });
    expect(compareSubjectIdentities(firstDomain, otherDomain)).toEqual({
      kind: "DISTINCT",
      basis: null,
    });
  });

  it("does not synthesize or accept unsafe canonical URLs", () => {
    const withoutUrl = identity({ name: "NickelMenu" });
    expect(withoutUrl.canonicalUrl).toBeNull();
    expect(withoutUrl.basis).toBe("NAME_CONTEXT");
    expect(() => identity({ canonicalUrl: "file:///private/project" })).toThrow(
      /canonical subject URL is invalid/u,
    );
  });
});
