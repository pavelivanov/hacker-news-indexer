import { describe, expect, it, vi } from "vitest";
import { createManualReviewService } from "@hn-knowledge/application";

describe("manual review service boundaries", () => {
  it("rejects malformed commands before opening a transaction", async () => {
    const run = vi.fn();
    const service = createManualReviewService(
      {
        run: async () => {
          run();
          throw new Error("Unexpected transaction");
        },
      },
      { sha256: (value) => value },
      { actorId: "owner", cursorSecret: "fixture" },
    );
    await expect(service.save("draft", { payload: {} })).rejects.toThrow(
      TypeError,
    );
    await expect(
      service.finalize("draft", "APPROVED", { actor: "spoofed" }),
    ).rejects.toThrow(TypeError);
    await expect(service.rebase("draft", 0)).rejects.toThrow(TypeError);
    await expect(service.inbox("all", "forged.signature")).rejects.toThrow(
      TypeError,
    );
    expect(run).not.toHaveBeenCalled();
  });
});
