import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { HackerNewsApiItems } from "@hn-knowledge/adapters";
import { hnItemId } from "@hn-knowledge/domain";

describe.skipIf(process.env["CONTRACT_SOURCE"] !== "hn")(
  "official HN API contract",
  () => {
    it("returns a known story through the item endpoint", async () => {
      const items = new HackerNewsApiItems({
        clock: { now: () => new Date() },
        hasher: {
          sha256: (value) => createHash("sha256").update(value).digest("hex"),
        },
      });

      const result = await items.get(hnItemId(8_863));

      expect(result).toMatchObject({
        kind: "ITEM",
        item: { id: 8_863, type: "story" },
      });
    });
  },
);
