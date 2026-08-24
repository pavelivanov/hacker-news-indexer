import type {
  HnItemId,
  IngestionRunId,
  OccurrenceStatus,
  SelectedOccurrenceContext,
  SelectionOccurrence,
  SelectionOccurrenceInput,
} from "@hn-knowledge/domain";
import {
  hnItemId,
  selectionOccurrenceId,
  telegramMessageId,
} from "@hn-knowledge/domain";
import type { OccurrenceRepository } from "@hn-knowledge/ports";

import { Prisma, type PrismaClient } from "../generated/prisma/client.js";

const jsonValue = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

const writeOccurrence = async (
  client: PrismaClient,
  runId: IngestionRunId,
  input: SelectionOccurrenceInput,
): Promise<SelectionOccurrence> =>
  client.$transaction(async (transaction) => {
    const unique = {
      source: input.source,
      sourceKey: input.sourceKey,
      externalId: BigInt(input.externalId),
    };
    const occurrence = await transaction.selectionOccurrence.upsert({
      where: { source_sourceKey_externalId: unique },
      create: {
        ...unique,
        occurredAt: input.occurredAt,
        editedAt: input.editedAt,
        contentHash: input.contentHash,
        status: input.status,
      },
      update: {
        occurredAt: input.occurredAt,
        editedAt: input.editedAt,
        contentHash: input.contentHash,
        status: input.status,
      },
    });
    await transaction.ingestionRunOccurrence.upsert({
      where: {
        ingestionRunId_occurrenceId: {
          ingestionRunId: runId,
          occurrenceId: occurrence.id,
        },
      },
      create: { ingestionRunId: runId, occurrenceId: occurrence.id },
      update: {},
    });
    await transaction.telegramMessage.upsert({
      where: { occurrenceId: occurrence.id },
      create: {
        occurrenceId: occurrence.id,
        entities: jsonValue(input.entities),
        displayedTextHash: input.contentHash,
        bodySnapshot: input.text,
        multipartPart: input.multipart?.part ?? null,
        multipartTotal: input.multipart?.total ?? null,
        deleted: input.status === "DELETED",
      },
      update: {
        entities: jsonValue(input.entities),
        displayedTextHash: input.contentHash,
        bodySnapshot: input.text,
        multipartPart: input.multipart?.part ?? null,
        multipartTotal: input.multipart?.total ?? null,
        deleted: input.status === "DELETED",
      },
    });
    await transaction.hnReference.deleteMany({
      where: { occurrenceId: occurrence.id },
    });
    if (input.references.length > 0) {
      await transaction.hnReference.createMany({
        data: input.references.map((reference) => ({
          occurrenceId: occurrence.id,
          hnItemId: BigInt(reference.itemId),
          role: reference.role,
          entityOffset: reference.entityOffset,
          entityLength: reference.entityLength,
          parseConfidence: reference.parseConfidence,
        })),
      });
    }

    return {
      ...input,
      id: selectionOccurrenceId(occurrence.id),
      ingestionRunId: runId,
    };
  });

export const createOccurrenceRepository = (
  client: PrismaClient,
): OccurrenceRepository => ({
  async upsert(runId, input): Promise<SelectionOccurrence> {
    try {
      return await writeOccurrence(client, runId, input);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return writeOccurrence(client, runId, input);
      }
      throw error;
    }
  },

  async clearTelegramBody(occurrenceId: string): Promise<void> {
    await client.telegramMessage.updateMany({
      where: { occurrenceId },
      data: { bodySnapshot: null },
    });
  },

  async listSelectedCommentOccurrences(
    runId: IngestionRunId,
    selectedCommentId: HnItemId,
  ): Promise<readonly SelectedOccurrenceContext[]> {
    const references = await client.hnReference.findMany({
      where: {
        hnItemId: BigInt(selectedCommentId),
        role: "SELECTED_COMMENT",
        occurrence: {
          runs: { some: { ingestionRunId: runId } },
        },
      },
      include: {
        occurrence: {
          include: {
            telegram: true,
            references: {
              where: { role: "DISPLAYED_STORY_REFERENCE" },
              orderBy: { entityOffset: "asc" },
              take: 1,
            },
          },
        },
      },
      orderBy: { occurrence: { externalId: "asc" } },
    });

    return references.map((reference) => {
      const occurrence = reference.occurrence;
      const telegram = occurrence.telegram;
      const displayed = occurrence.references[0];
      return {
        occurrenceId: selectionOccurrenceId(occurrence.id),
        messageId: telegramMessageId(Number(occurrence.externalId)),
        selectedCommentId: hnItemId(Number(reference.hnItemId)),
        displayedStoryId:
          displayed === undefined ? null : hnItemId(Number(displayed.hnItemId)),
        occurredAt: occurrence.occurredAt,
        text: telegram?.bodySnapshot ?? null,
        multipart:
          telegram?.multipartPart === null ||
          telegram?.multipartPart === undefined ||
          telegram.multipartTotal === null
            ? null
            : {
                part: telegram.multipartPart,
                total: telegram.multipartTotal,
              },
      };
    });
  },

  async setStatus(
    occurrenceId: string,
    status: OccurrenceStatus,
  ): Promise<void> {
    await client.selectionOccurrence.update({
      where: { id: occurrenceId },
      data: { status },
    });
  },
});
