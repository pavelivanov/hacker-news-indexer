import { describe, expect, it } from "vitest";

import {
  hnItemId,
  ingestionRunId,
  telegramMessageId,
  type HnItemId,
  type TelegramMessageId,
} from "@hn-knowledge/domain";

describe("domain identities", () => {
  it("creates separate HN and Telegram identities", () => {
    const hnId = hnItemId(49_348_450);
    const telegramId = telegramMessageId(32_847);

    expect(hnId).toBe(49_348_450);
    expect(telegramId).toBe(32_847);

    // @ts-expect-error HN IDs cannot cross the Telegram boundary.
    const invalidTelegramId: TelegramMessageId = hnId;
    // @ts-expect-error Telegram IDs cannot cross the HN boundary.
    const invalidHnId: HnItemId = telegramId;
    expect(invalidTelegramId).toBe(hnId);
    expect(invalidHnId).toBe(telegramId);
  });

  it.each([0, -1, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid numeric identity %s",
    (value) => {
      expect(() => telegramMessageId(value)).toThrow(TypeError);
      expect(() => hnItemId(value)).toThrow(TypeError);
    },
  );

  it("validates bounded string identities", () => {
    expect(ingestionRunId(" run-1 ")).toBe("run-1");
    expect(() => ingestionRunId(" ")).toThrow(TypeError);
    expect(() => ingestionRunId("x".repeat(129))).toThrow(TypeError);
  });
});
