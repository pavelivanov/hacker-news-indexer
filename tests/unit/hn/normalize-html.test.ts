import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { normalizeHnCommentHtml } from "@hn-knowledge/application";

const hasher = {
  sha256: (value: string) => createHash("sha256").update(value).digest("hex"),
};

describe("canonical HN comment normalization", () => {
  it("normalizes entities, paragraphs, code, and safe anchors deterministically", () => {
    const html = [
      "Hello &amp; <b>world</b>",
      '<p>Second&nbsp;paragraph <a rel="nofollow" href="item?id=123&amp;ignored=yes">thread</a>',
      "<p><pre><code>if (a &lt; b) {\n  run();\n}</code></pre>",
    ].join("");

    const first = normalizeHnCommentHtml(html, "hn:item:500", hasher);
    const second = normalizeHnCommentHtml(html, "hn:item:500", hasher);

    expect(second).toEqual(first);
    expect(first.canonicalHtml).toContain("Hello &amp; <strong>world</strong>");
    expect(first.canonicalHtml).toContain(
      '<a href="https://news.ycombinator.com/item?id=123">thread</a>',
    );
    expect(first.canonicalHtml).not.toContain("rel=");
    expect(first.canonicalText).toBe(
      "Hello & world\n\nSecond paragraph thread\n\nif (a < b) {\n  run();\n}",
    );
    expect(first.blocks).toEqual([
      { kind: "TEXT", text: "Hello & world" },
      { kind: "TEXT", text: "Second paragraph thread" },
      { kind: "CODE", text: "if (a < b) {\n  run();\n}" },
    ]);
    expect(first.contentHash).toBe(hasher.sha256(first.canonicalHtml));
  });

  it("rejects unsafe schemes without losing visible anchor text", () => {
    const normalized = normalizeHnCommentHtml(
      '<a href="javascript:alert(1)">click me</a><script>secret()</script>',
      "hn:item:501",
      hasher,
    );

    expect(normalized.canonicalHtml).toBe("click me");
    expect(normalized.canonicalText).toBe("click me");
    expect(normalized.canonicalHtml).not.toContain("javascript");
    expect(normalized.canonicalHtml).not.toContain("secret");
    expect(normalized.urlCandidates).toMatchObject([
      {
        rawUrl: "javascript:alert(1)",
        canonicalUrl: null,
        scheme: "javascript",
        validationState: "REJECTED",
      },
    ]);
  });

  it("extracts only anchors and ignores Telegram-style bare-domain false positives", () => {
    const normalized = normalizeHnCommentHtml(
      'AGENTS.md OpenStreetMap.org crates.io <a href="https://crates.io/crates/serde">serde</a>',
      "hn:item:502",
      hasher,
    );

    expect(normalized.urlCandidates).toHaveLength(1);
    expect(normalized.urlCandidates[0]).toMatchObject({
      rawUrl: "https://crates.io/crates/serde",
      canonicalUrl: "https://crates.io/crates/serde",
      scheme: "https",
      host: "crates.io",
      validationState: "VALID",
    });
    expect(normalized.canonicalText).toContain(
      "AGENTS.md OpenStreetMap.org crates.io serde",
    );
  });
});
