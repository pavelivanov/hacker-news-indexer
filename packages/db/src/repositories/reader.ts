import { hnItemId, type HnItemId, type SubjectId } from "@hn-knowledge/domain";
import type {
  KnowledgeReaderRepository,
  ReaderContentRecord,
  ReaderDiscoveryRecord,
  ReaderEvidenceRecord,
  ReaderExpertNoteRecord,
  ReaderPublicationRecord,
} from "@hn-knowledge/ports";

import type { PrismaClient } from "../generated/prisma/client.js";

const positiveLimit = (value: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1_001) {
    throw new TypeError("reader limit must be between 1 and 1001");
  }
  return value;
};

const publication = (decision: {
  readonly reviewRequired: boolean;
  readonly createdAt: Date;
  readonly reviewTasks: readonly {
    readonly revision: number;
    readonly resolvedAt: Date | null;
  }[];
}): ReaderPublicationRecord | null => {
  const approved = decision.reviewTasks[0];
  if (decision.reviewRequired && approved === undefined) {
    return null;
  }
  return {
    publishedAt: approved?.resolvedAt ?? decision.createdAt,
    updatedAt: approved?.resolvedAt ?? decision.createdAt,
    reviewRevision: approved?.revision ?? 0,
    publicationRevision: 1,
  };
};

const boundedExcerpt = (value: string, start: number, end: number): string =>
  value.slice(start, end).trim().slice(0, 500);

const evidenceRecord = (
  span: {
    readonly origin: "COMMENT" | "ROOT_STORY";
    readonly sourceDocument: string;
    readonly startOffset: number;
    readonly endOffset: number;
  },
  context: {
    readonly commentId: HnItemId;
    readonly commentText: string;
    readonly rootId: HnItemId;
    readonly rootTitle: string;
    readonly rootText: string;
  },
): ReaderEvidenceRecord | null => {
  const source =
    span.origin === "COMMENT"
      ? context.commentText
      : span.sourceDocument.startsWith("root-title:")
        ? context.rootTitle
        : context.rootText;
  const excerpt = boundedExcerpt(source, span.startOffset, span.endOffset);
  if (excerpt.length === 0) {
    return null;
  }
  return {
    origin: span.origin,
    hnItemId: span.origin === "COMMENT" ? context.commentId : context.rootId,
    start: span.startOffset,
    end: span.endOffset,
    excerpt,
  };
};

const compareRecords = (
  left: ReaderContentRecord,
  right: ReaderContentRecord,
): number =>
  right.publishedAt.getTime() - left.publishedAt.getTime() ||
  right.confidence - left.confidence ||
  left.id.localeCompare(right.id);

export const createKnowledgeReaderRepository = (
  client: PrismaClient,
): KnowledgeReaderRepository => ({
  async listPublishedContent(filter) {
    const limit = positiveLimit(filter.limit);
    const includeDiscoveries = filter.kind !== "expert_note";
    const includeExpertNotes = filter.kind !== "discovery";
    const [discoveries, expertNotes] = await Promise.all([
      includeDiscoveries
        ? client.discovery.findMany({
            where: {
              status: { notIn: ["REJECTED", "SUPERSEDED"] },
              ...(filter.subjectId === null
                ? {}
                : { subjectId: filter.subjectId }),
              ...(filter.resolvedRootId === null
                ? {}
                : {
                    sources: {
                      some: {
                        selectedComment: {
                          rootId: BigInt(filter.resolvedRootId),
                        },
                      },
                    },
                  }),
              ...(filter.selectedCommentId === null
                ? {}
                : {
                    sources: {
                      some: {
                        selectedCommentId: BigInt(filter.selectedCommentId),
                      },
                    },
                  }),
            },
            include: {
              subject: true,
              sources: {
                include: {
                  selectedComment: {
                    include: { item: true, resolutionPath: true },
                  },
                  contentDecision: {
                    include: {
                      reviewTasks: {
                        where: {
                          kind: "CONTENT_DECISION",
                          state: "APPROVED",
                        },
                        orderBy: [{ resolvedAt: "desc" }, { id: "asc" }],
                        take: 1,
                      },
                    },
                  },
                  evidenceSpans: { include: { evidenceSpan: true } },
                },
              },
            },
            take: limit,
          })
        : Promise.resolve([]),
      includeExpertNotes
        ? client.expertNote.findMany({
            where: {
              status: { notIn: ["REJECTED", "SUPERSEDED"] },
              ...(filter.subjectId === null
                ? {}
                : { subjects: { some: { subjectId: filter.subjectId } } }),
              ...(filter.resolvedRootId === null
                ? {}
                : {
                    selectedComment: {
                      rootId: BigInt(filter.resolvedRootId),
                    },
                  }),
              ...(filter.selectedCommentId === null
                ? {}
                : { selectedCommentId: BigInt(filter.selectedCommentId) }),
            },
            include: {
              selectedComment: {
                include: { item: true, resolutionPath: true },
              },
              contentDecision: {
                include: {
                  reviewTasks: {
                    where: {
                      kind: "CONTENT_DECISION",
                      state: "APPROVED",
                    },
                    orderBy: [{ resolvedAt: "desc" }, { id: "asc" }],
                    take: 1,
                  },
                },
              },
              subjects: { include: { subject: true } },
              evidenceSpans: { include: { evidenceSpan: true } },
            },
            take: limit,
          })
        : Promise.resolve([]),
    ]);

    const commentIds = new Set<bigint>();
    for (const discovery of discoveries) {
      for (const source of discovery.sources) {
        commentIds.add(source.selectedCommentId);
      }
    }
    for (const note of expertNotes) {
      commentIds.add(note.selectedCommentId);
    }
    const rootIds = new Set<bigint>();
    for (const discovery of discoveries) {
      for (const source of discovery.sources) {
        rootIds.add(source.selectedComment.rootId);
      }
    }
    for (const note of expertNotes) {
      rootIds.add(note.selectedComment.rootId);
    }
    const [rootItems, references] = await Promise.all([
      client.hnItem.findMany({
        where: { id: { in: [...rootIds] }, availability: "AVAILABLE" },
      }),
      client.hnReference.findMany({
        where: {
          hnItemId: { in: [...commentIds] },
          role: "SELECTED_COMMENT",
          occurrence: { status: { in: ["OBSERVED", "RESOLVED"] } },
        },
        select: { hnItemId: true, occurrenceId: true },
      }),
    ]);
    const roots = new Map(rootItems.map((item) => [item.id, item] as const));
    const occurrences = new Map<bigint, string[]>();
    for (const reference of references) {
      const values = occurrences.get(reference.hnItemId) ?? [];
      values.push(reference.occurrenceId);
      occurrences.set(reference.hnItemId, values);
    }

    const discoveryRecords: ReaderDiscoveryRecord[] = [];
    for (const discovery of discoveries) {
      const eligible = discovery.sources
        .map((source) => ({
          source,
          publication: publication(source.contentDecision),
        }))
        .filter(
          (entry) =>
            entry.source.selectedComment.activeDecisionId ===
              entry.source.contentDecisionId &&
            entry.source.selectedComment.availability === "AVAILABLE" &&
            entry.source.selectedComment.item.availability === "AVAILABLE" &&
            entry.source.selectedComment.resolutionPath !== null &&
            entry.publication !== null &&
            roots.has(entry.source.selectedComment.rootId),
        )
        .sort(
          (left, right) =>
            (right.publication?.publishedAt.getTime() ?? 0) -
              (left.publication?.publishedAt.getTime() ?? 0) ||
            right.source.confidence - left.source.confidence ||
            left.source.id.localeCompare(right.source.id),
        );
      const selected = eligible[0];
      if (selected === undefined || selected.publication === null) {
        continue;
      }
      const selectedComment = selected.source.selectedComment;
      const root = roots.get(selectedComment.rootId);
      if (root === undefined) {
        continue;
      }
      const evidence = selected.source.evidenceSpans
        .map(({ evidenceSpan }) =>
          evidenceRecord(evidenceSpan, {
            commentId: hnItemId(Number(selectedComment.id)),
            commentText: selectedComment.canonicalText,
            rootId: hnItemId(Number(selectedComment.rootId)),
            rootTitle: root.title ?? "",
            rootText: root.textPlain ?? "",
          }),
        )
        .filter((value): value is ReaderEvidenceRecord => value !== null);
      if (evidence.length === 0) {
        continue;
      }
      discoveryRecords.push({
        id: discovery.id,
        kind: "discovery",
        title: discovery.subject.name,
        summary: selected.source.descriptionClaim,
        confidence: selected.source.confidence,
        subjects: [
          {
            id: discovery.subject.id,
            name: discovery.subject.name,
            type: discovery.subject.type,
          },
        ],
        evidence,
        selectedCommentId: hnItemId(Number(selectedComment.id)),
        resolvedRootId: hnItemId(Number(selectedComment.rootId)),
        displayedStoryId:
          selectedComment.resolutionPath?.displayedStoryId === null ||
          selectedComment.resolutionPath?.displayedStoryId === undefined
            ? null
            : hnItemId(Number(selectedComment.resolutionPath.displayedStoryId)),
        sourceOccurrenceIds: [
          ...new Set(
            eligible.flatMap(
              (entry) => occurrences.get(entry.source.selectedCommentId) ?? [],
            ),
          ),
        ],
        ...selected.publication,
        publicationRevision: discovery.publicationRevision,
        updatedAt:
          discovery.updatedAt > selected.publication.updatedAt
            ? discovery.updatedAt
            : selected.publication.updatedAt,
      });
    }

    const noteRecords: ReaderExpertNoteRecord[] = [];
    for (const note of expertNotes) {
      const selected = note.selectedComment;
      const published = publication(note.contentDecision);
      const root = roots.get(selected.rootId);
      if (
        selected.activeDecisionId !== note.contentDecisionId ||
        selected.availability !== "AVAILABLE" ||
        selected.item.availability !== "AVAILABLE" ||
        selected.resolutionPath === null ||
        published === null ||
        root === undefined
      ) {
        continue;
      }
      const evidence = note.evidenceSpans
        .map(({ evidenceSpan }) =>
          evidenceRecord(evidenceSpan, {
            commentId: hnItemId(Number(selected.id)),
            commentText: selected.canonicalText,
            rootId: hnItemId(Number(selected.rootId)),
            rootTitle: root.title ?? "",
            rootText: root.textPlain ?? "",
          }),
        )
        .filter((value): value is ReaderEvidenceRecord => value !== null);
      if (evidence.length === 0) {
        continue;
      }
      noteRecords.push({
        id: note.id,
        kind: "expert_note",
        noteType: note.noteType,
        title: note.title,
        summary: note.summary,
        confidence: note.confidence,
        subjects: note.subjects.map(({ subject }) => ({
          id: subject.id,
          name: subject.name,
          type: subject.type,
        })),
        evidence,
        selectedCommentId: hnItemId(Number(selected.id)),
        resolvedRootId: hnItemId(Number(selected.rootId)),
        displayedStoryId:
          selected.resolutionPath.displayedStoryId === null
            ? null
            : hnItemId(Number(selected.resolutionPath.displayedStoryId)),
        sourceOccurrenceIds: occurrences.get(selected.id) ?? [],
        ...published,
        publicationRevision: note.publicationRevision,
        updatedAt:
          note.updatedAt > published.updatedAt
            ? note.updatedAt
            : published.updatedAt,
      });
    }

    return [...discoveryRecords, ...noteRecords]
      .sort(compareRecords)
      .slice(0, limit);
  },

  async getAvailableComment(id) {
    const selected = await client.selectedComment.findFirst({
      where: {
        id: BigInt(id),
        availability: "AVAILABLE",
        item: { availability: "AVAILABLE" },
      },
      include: { item: true, resolutionPath: true },
    });
    if (selected?.resolutionPath === null || selected === null) {
      return null;
    }
    const references = await client.hnReference.findMany({
      where: {
        hnItemId: selected.id,
        role: "SELECTED_COMMENT",
        occurrence: { status: { in: ["OBSERVED", "RESOLVED"] } },
      },
      select: { occurrenceId: true },
      orderBy: { occurrenceId: "asc" },
    });
    return {
      id: hnItemId(Number(selected.id)),
      author: selected.item.author,
      canonicalHtml: selected.canonicalHtml,
      canonicalText: selected.canonicalText,
      createdAt: selected.item.time,
      resolvedRootId: hnItemId(Number(selected.rootId)),
      displayedStoryId:
        selected.resolutionPath.displayedStoryId === null
          ? null
          : hnItemId(Number(selected.resolutionPath.displayedStoryId)),
      sourceOccurrenceIds: references.map((value) => value.occurrenceId),
    };
  },

  async getAvailableStory(id) {
    const item = await client.hnItem.findFirst({
      where: { id: BigInt(id), type: "story", availability: "AVAILABLE" },
    });
    return item === null
      ? null
      : {
          id: hnItemId(Number(item.id)),
          title: item.title,
          author: item.author,
          canonicalHtml: item.textHtml ?? "",
          canonicalText: item.textPlain ?? "",
          url: item.url,
          createdAt: item.time,
        };
  },

  async getActiveSubject(id: SubjectId) {
    const subject = await client.subject.findFirst({
      where: { id, lifecycleState: "ACTIVE" },
      include: {
        aliases: { orderBy: [{ normalizedAlias: "asc" }, { id: "asc" }] },
        canonicalUrlCandidate: true,
      },
    });
    return subject === null
      ? null
      : {
          id: subject.id,
          name: subject.name,
          type: subject.type,
          aliases: subject.aliases.map((alias) => alias.alias),
          canonicalUrl: subject.canonicalUrlCandidate?.canonicalUrl ?? null,
          createdAt: subject.createdAt,
          updatedAt: subject.updatedAt,
        };
  },
});
