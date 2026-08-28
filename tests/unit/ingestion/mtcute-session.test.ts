import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  destroyed: 0,
  getMeCalls: 0,
  importedSessions: [] as string[],
  rejectImport: false,
  storageKinds: [] as string[],
}));

vi.mock("@mtcute/node", () => ({
  MemoryStorage: class MemoryStorage {
    readonly kind = "memory";
  },
  TelegramClient: class TelegramClient {
    constructor(options: { storage: object }) {
      state.storageKinds.push(options.storage.constructor.name);
    }

    importSession(session: string): Promise<void> {
      state.importedSessions.push(session);
      return state.rejectImport
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
    state.storageKinds.length = 0;
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

    await telegram.close();
    expect(state.destroyed).toBe(1);
  });

  it("destroys the client when session import fails", async () => {
    state.rejectImport = true;

    await expect(
      createMtcuteTelegramSource({
        apiId: 12_345,
        apiHash: "api-hash",
        session: "invalid-session",
        hasher,
      }),
    ).rejects.toThrow("invalid session");

    expect(state.getMeCalls).toBe(0);
    expect(state.destroyed).toBe(1);
  });
});
