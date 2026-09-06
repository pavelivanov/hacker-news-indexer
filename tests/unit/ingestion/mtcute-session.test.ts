import { createHash } from "node:crypto";

import { convertToGramjsSession } from "@mtcute/convert";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  destroyed: 0,
  getMeCalls: 0,
  importedSessions: [] as unknown[],
  rejectImport: false,
  rejectStringImport: false,
  storageKinds: [] as string[],
  historyCalls: [] as unknown[],
}));

vi.mock("@mtcute/node", () => ({
  MemoryStorage: class MemoryStorage {
    readonly kind = "memory";
  },
  TelegramClient: class TelegramClient {
    constructor(options: { storage: object }) {
      state.storageKinds.push(options.storage.constructor.name);
    }

    importSession(session: unknown): Promise<void> {
      state.importedSessions.push(session);
      return state.rejectImport ||
        (state.rejectStringImport && typeof session === "string")
        ? Promise.reject(new Error("invalid session"))
        : Promise.resolve();
    }

    getMe(): Promise<object> {
      state.getMeCalls += 1;
      return Promise.resolve({});
    }

    getMessages(): Promise<readonly []> {
      return Promise.resolve([]);
    }
    getHistory(sourceKey: string, options: unknown) {
      state.historyCalls.push([sourceKey, options]);
      return Promise.resolve([{ id: 42 }]);
    }

    destroy(): Promise<void> {
      state.destroyed += 1;
      return Promise.resolve();
    }
  },
}));

import { createMtcuteTelegramSource } from "@hn-knowledge/adapters";

const hasher = {
  sha256: (value: string): string =>
    createHash("sha256").update(value).digest("hex"),
};

describe("mtcute serialized sessions", () => {
  beforeEach(() => {
    state.destroyed = 0;
    state.getMeCalls = 0;
    state.importedSessions.length = 0;
    state.rejectImport = false;
    state.rejectStringImport = false;
    state.storageKinds.length = 0;
    state.historyCalls.length = 0;
  });

  it("imports and verifies a serialized session in memory", async () => {
    const telegram = await createMtcuteTelegramSource({
      apiId: 12_345,
      apiHash: "api-hash",
      session: "serialized-session",
      hasher,
    });

    expect(state.importedSessions).toEqual(["serialized-session"]);
    expect(state.getMeCalls).toBe(1);
    expect(state.storageKinds).toEqual(["MemoryStorage"]);
    expect(telegram.sessionFormat).toBe("mtcute");
    expect(await telegram.latestId("fixture-channel")).toBe(42);
    expect(state.historyCalls).toEqual([["fixture-channel", { limit: 1 }]]);

    await telegram.close();
    expect(state.destroyed).toBe(1);
  });

  it("converts a GramJS string when native mtcute import rejects it", async () => {
    const dc = {
      id: 2,
      ipAddress: "149.154.167.51",
      port: 443,
      testMode: false,
    };
    const session = convertToGramjsSession({
      version: 3,
      primaryDcs: { main: dc, media: dc },
      self: null,
      authKey: new Uint8Array(256).fill(7),
    });
    state.rejectStringImport = true;

    const telegram = await createMtcuteTelegramSource({
      apiId: 12_345,
      apiHash: "api-hash",
      session,
      hasher,
    });

    expect(state.importedSessions).toHaveLength(2);
    expect(typeof state.importedSessions[0]).toBe("string");
    expect(state.importedSessions[1]).toMatchObject({ version: 3 });
    expect(telegram.sessionFormat).toBe("gramjs");

    await telegram.close();
    expect(state.destroyed).toBe(2);
  });

  it("destroys the client when no supported session format imports", async () => {
    state.rejectImport = true;

    await expect(
      createMtcuteTelegramSource({
        apiId: 12_345,
        apiHash: "api-hash",
        session: "invalid-session",
        hasher,
      }),
    ).rejects.toThrow("Unsupported Telegram session format");

    expect(state.getMeCalls).toBe(0);
    expect(state.destroyed).toBe(1);
  });
});
