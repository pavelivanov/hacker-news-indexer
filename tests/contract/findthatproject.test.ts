import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  FindThatProjectContractError,
  FixtureFindThatProjectConsumer,
} from "@hn-knowledge/adapters";

const json = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

describe.skipIf(process.env["CONTRACT_SOURCE"] !== "findthatproject")(
  "FindThatProject dry-run contract",
  () => {
    it("validates the owner-approved fixture without downstream mutation", async () => {
      expect(process.env["CONTRACT_DRY_RUN"]).toBe("true");
      const approval = (await json(
        "../../contracts/findthatproject/approval-v1.json",
      )) as Record<string, unknown>;
      expect(approval).toMatchObject({
        schemaVersion: "findthatproject.discovery.v1",
        status: "APPROVED",
        pullOnly: true,
        mutatingDownstreamAuthorized: false,
      });
      const consumer = new FixtureFindThatProjectConsumer(
        approval["status"] === "APPROVED",
      );
      const payload = consumer.validate(
        await json("../../contracts/findthatproject/upsert-v1.fixture.json"),
      );

      expect(payload).toMatchObject({ action: "UPSERT", kind: "DISCOVERY" });
      expect(consumer.mutatingRequests).toBe(0);
    });

    it("fails closed without recorded approval", () => {
      const consumer = new FixtureFindThatProjectConsumer(false);
      expect(() =>
        consumer.validate({ schema_version: "findthatproject.discovery.v1" }),
      ).toThrow(FindThatProjectContractError);
      expect(consumer.mutatingRequests).toBe(0);
    });
  },
);
