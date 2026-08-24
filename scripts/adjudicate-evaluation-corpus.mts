import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type PrimaryClass = "DISCOVERY" | "EXPERT_NOTE" | "REJECTED";
type EvidenceOrigin = "COMMENT" | "ROOT_STORY";

interface ProposedSpan {
  readonly origin: EvidenceOrigin;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface AgentRow {
  readonly commentId: number;
  readonly primaryClass: PrimaryClass;
  readonly discoveries: readonly {
    readonly subjectType: string;
    readonly name: string;
    readonly aliases: readonly string[];
    readonly description: string;
    readonly evidenceOrigin: string;
    readonly evidenceSpans: readonly ProposedSpan[];
    readonly urlCandidates: readonly string[];
    readonly rootOnly: boolean;
  }[];
  readonly expertNote: null | {
    readonly noteType: string;
    readonly title: string;
    readonly summary: string;
    readonly evidenceOrigin: string;
    readonly evidenceSpans: readonly ProposedSpan[];
    readonly relatedSubjectNames: readonly string[];
    readonly qualifiers: readonly string[];
  };
  readonly reviewFlags: readonly string[];
  readonly rejectionReason: string | null;
}

interface EvaluationDocument {
  readonly commentId: number;
  readonly rootId: number;
  readonly urlCandidates: readonly {
    readonly id: string;
    readonly url: string;
  }[];
}

interface EvaluationSource {
  readonly documents: readonly EvaluationDocument[];
}

interface HoldoutFile {
  readonly commentIds: readonly number[];
}

interface Adjudication {
  readonly primaryClass: PrimaryClass;
  readonly preferred: "A" | "B" | "OVERRIDE";
  readonly rationale: string;
  readonly rejectionReason?: string;
}

const disagreementAdjudications = new Map<number, Adjudication>([
  [
    49361052,
    {
      primaryClass: "DISCOVERY",
      preferred: "A",
      rationale:
        "The comment materially identifies GrapheneOS and grounds its Android application compatibility; this is more than an incidental root mention.",
    },
  ],
  [
    49363671,
    {
      primaryClass: "EXPERT_NOTE",
      preferred: "A",
      rationale:
        "The unnamed telemetry system is evidence for a reusable dual-use security observation, not a sufficiently identified standalone resource.",
    },
  ],
  [
    49366396,
    {
      primaryClass: "DISCOVERY",
      preferred: "A",
      rationale:
        "The comment materially describes OpenRouter as a multi-provider API and explains its two-sided value rather than merely reacting to acquisition news.",
    },
  ],
  [
    49372025,
    {
      primaryClass: "DISCOVERY",
      preferred: "B",
      rationale:
        "The named Principles of AI Use document is itself a bounded guide, with its operative principles reproduced in comment evidence.",
    },
  ],
  [
    49380334,
    {
      primaryClass: "REJECTED",
      preferred: "B",
      rationale:
        "The comment is a subjective characterization of programming and delegation without a durable technical mechanism or actionable caveat.",
    },
  ],
  [
    49382737,
    {
      primaryClass: "EXPERT_NOTE",
      preferred: "B",
      rationale:
        "The reusable value is the reported refusal-profile comparison; Ox Alpha is already the root subject and is not newly established by the comment.",
    },
  ],
  [
    49403412,
    {
      primaryClass: "REJECTED",
      preferred: "A",
      rationale:
        "A one-line expression of surprise about an ambiguously named model build lacks reusable detail and a grounded canonical subject URL.",
    },
  ],
  [
    49403945,
    {
      primaryClass: "EXPERT_NOTE",
      preferred: "A",
      rationale:
        "The comment provides a material historical correction about 15.ai's name, creator context, and free voice-synthesis purpose.",
    },
  ],
]);

const consensusOverrides = new Map<number, Adjudication>([
  [
    49376272,
    {
      primaryClass: "REJECTED",
      preferred: "OVERRIDE",
      rejectionReason: "LOW_INFORMATION",
      rationale:
        "The proposed browser explanation is explicitly speculative and supplies no reproducible mechanism, so it fails the conservative materiality gate.",
    },
  ],
  [
    49382571,
    {
      primaryClass: "REJECTED",
      preferred: "OVERRIDE",
      rejectionReason: "GENERIC_OPINION",
      rationale:
        "The architecture concern remains a generalized opinion about agent scale without a concrete reusable implementation detail.",
    },
  ],
  [
    49392339,
    {
      primaryClass: "REJECTED",
      preferred: "OVERRIDE",
      rejectionReason: "NEWS_WITHOUT_REUSABLE_DETAIL",
      rationale:
        "The observation that Archive pages are blocked in Italy provides no mechanism, mitigation, or durable technical instruction.",
    },
  ],
  [
    49392826,
    {
      primaryClass: "REJECTED",
      preferred: "OVERRIDE",
      rejectionReason: "LOW_INFORMATION",
      rationale:
        "The phone-imaging scenario is a hypothetical wish rather than a demonstrated technique and is unsafe to retain as procedural guidance.",
    },
  ],
  [
    49395024,
    {
      primaryClass: "REJECTED",
      preferred: "OVERRIDE",
      rejectionReason: "LOW_INFORMATION",
      rationale:
        "The destructive decoy-passcode behavior is speculative and unsupported by implementation evidence, so it is not retained as a technical note.",
    },
  ],
  [
    49396801,
    {
      primaryClass: "REJECTED",
      preferred: "OVERRIDE",
      rejectionReason: "GENERIC_OPINION",
      rationale:
        "The comment offers general legal caution and political framing, not a reusable technical mechanism or grounded procedure.",
    },
  ],
  [
    49401919,
    {
      primaryClass: "REJECTED",
      preferred: "OVERRIDE",
      rejectionReason: "PERSONAL_STORY",
      rationale:
        "A single failed configuration-edit anecdote has insufficient context to support a durable product-experience claim.",
    },
  ],
]);

const reviewFlagMap = new Map<string, string>([
  ["AMBIGUOUS_CLASSIFICATION", "AMBIGUOUS_CLASSIFICATION"],
  ["AMBIGUOUS_PRODUCT_IDENTITY", "AMBIGUOUS_CLASSIFICATION"],
  ["DESTRUCTIVE_OR_EVASION_ADVICE", "DESTRUCTIVE_OR_EVASION_ADVICE"],
  ["FLAGGED_CONTENT", "UNAVAILABLE_CONTENT"],
  ["FLAGGED_OR_UNAVAILABLE_CONTENT", "UNAVAILABLE_CONTENT"],
  ["LEGAL_CLAIM", "LEGAL_RECOMMENDATION"],
  ["LEGAL_RECOMMENDATION", "LEGAL_RECOMMENDATION"],
  ["LOW_CONFIDENCE", "LOW_CONFIDENCE"],
  ["MEDICAL_CLAIM", "MEDICAL_RECOMMENDATION"],
  ["MEDICAL_RECOMMENDATION", "MEDICAL_RECOMMENDATION"],
  ["MISSING_OR_AMBIGUOUS_CANONICAL_URL", "AMBIGUOUS_CANONICAL_URL"],
  ["SECURITY_RECOMMENDATION", "SECURITY_RECOMMENDATION"],
  ["SECURITY_SENSITIVE_CONTENT", "SECURITY_RECOMMENDATION"],
  ["UNAVAILABLE_CONTENT", "UNAVAILABLE_CONTENT"],
]);
const rejectionReasonMap = new Map<string, string>([
  ["GENERIC_OPINION", "GENERIC_OPINION"],
  ["INCIDENTAL_MENTION", "INCIDENTAL_MENTION"],
  ["JOKE_OR_ONE_LINER", "JOKE_OR_ONE_LINER"],
  ["NEWS_WITHOUT_REUSABLE_DETAIL", "NEWS_WITHOUT_REUSABLE_DETAIL"],
  ["PERSONAL_STORY_NO_USABLE_SUBJECT", "PERSONAL_STORY"],
  ["POLITICS_NO_TECHNICAL_SUBJECT", "NON_TECHNICAL"],
  ["UNAVAILABLE_CONTENT", "UNAVAILABLE_CONTENT"],
]);

const parseJsonl = async (filePath: string): Promise<AgentRow[]> =>
  (await readFile(filePath, "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AgentRow);

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const spanKey = (span: ProposedSpan): string =>
  `${span.origin}\u0000${span.start}\u0000${span.end}\u0000${span.text}`;

const root = path.resolve(process.cwd());
const [a, b, source, holdout] = await Promise.all([
  parseJsonl(path.join(root, "evaluation/annotations/annotator-a.jsonl")),
  parseJsonl(path.join(root, "evaluation/annotations/annotator-b.jsonl")),
  readFile("/tmp/hn-evaluation-source.json", "utf8").then(
    (value) => JSON.parse(value) as EvaluationSource,
  ),
  readFile(path.join(root, "evaluation/holdout-v1.json"), "utf8").then(
    (value) => JSON.parse(value) as HoldoutFile,
  ),
]);
const bById = new Map(b.map((row) => [row.commentId, row]));
const sourceById = new Map(
  source.documents.map((document) => [document.commentId, document]),
);
const holdoutIds = new Set(holdout.commentIds);

const gold = a.map((aRow) => {
  const bRow = bById.get(aRow.commentId);
  const document = sourceById.get(aRow.commentId);
  if (bRow === undefined || document === undefined) {
    throw new Error(`Missing comparison input for ${aRow.commentId}`);
  }
  const disagreed = aRow.primaryClass !== bRow.primaryClass;
  const decision = consensusOverrides.get(aRow.commentId) ??
    disagreementAdjudications.get(aRow.commentId) ?? {
      primaryClass: aRow.primaryClass,
      preferred: "A" as const,
      rationale:
        "Independent annotators agreed; evidence and class invariants were mechanically validated.",
    };
  if (disagreed !== disagreementAdjudications.has(aRow.commentId)) {
    throw new Error(
      `Unaccounted annotation disagreement for ${aRow.commentId}`,
    );
  }
  const selected = decision.preferred === "B" ? bRow : aRow;
  const rejectedByOverride = decision.preferred === "OVERRIDE";
  const proposedSpans = rejectedByOverride
    ? []
    : [
        ...selected.discoveries.flatMap((discovery) => discovery.evidenceSpans),
        ...(selected.expertNote?.evidenceSpans ?? []),
      ];
  const uniqueSpans = [
    ...new Map(proposedSpans.map((span) => [spanKey(span), span])).values(),
  ];
  const counters = { COMMENT: 0, ROOT_STORY: 0 };
  const spanIds = new Map<string, string>();
  const evidenceSpans = uniqueSpans.map((span) => {
    const label = span.origin === "COMMENT" ? "comment" : "root";
    const id = `span:${label}:${counters[span.origin]++}`;
    spanIds.set(spanKey(span), id);
    return {
      id,
      documentId:
        span.origin === "COMMENT"
          ? `comment:${aRow.commentId}`
          : `root:${document.rootId}`,
      origin: span.origin,
      start: span.start,
      end: span.end,
      text: span.text,
      textSha256: sha256(span.text),
    };
  });
  const idsFor = (spans: readonly ProposedSpan[]): string[] =>
    spans.map((span) => {
      const id = spanIds.get(spanKey(span));
      if (id === undefined) {
        throw new Error(`Missing span ID for ${aRow.commentId}`);
      }
      return id;
    });
  const candidateId = (url: string): string => {
    const candidate = document.urlCandidates.find((value) => value.url === url);
    if (candidate === undefined) {
      throw new Error(`Unknown URL candidate for ${aRow.commentId}`);
    }
    return candidate.id;
  };
  const normalizedFlags = [
    ...new Set(
      selected.reviewFlags.map((flag) => {
        const normalized = reviewFlagMap.get(flag);
        if (normalized === undefined) {
          throw new Error(`Unknown review flag ${flag}`);
        }
        return normalized;
      }),
    ),
  ].sort();
  const rejectionReason =
    decision.primaryClass !== "REJECTED"
      ? null
      : (decision.rejectionReason ??
        (selected.rejectionReason === null
          ? "LOW_INFORMATION"
          : rejectionReasonMap.get(selected.rejectionReason)));
  if (decision.primaryClass === "REJECTED" && rejectionReason === undefined) {
    throw new Error(`Missing rejection reason for ${aRow.commentId}`);
  }

  return {
    schemaVersion: "gold.v1",
    commentId: aRow.commentId,
    primaryClass: decision.primaryClass,
    evidenceSpans: decision.primaryClass === "REJECTED" ? [] : evidenceSpans,
    discoveries:
      decision.primaryClass !== "DISCOVERY"
        ? []
        : selected.discoveries.map((discovery) => ({
            subjectType: discovery.subjectType,
            name: discovery.name,
            aliases: discovery.aliases,
            description: discovery.description,
            evidenceOrigin: discovery.evidenceOrigin,
            evidenceSpanIds: idsFor(discovery.evidenceSpans),
            urlCandidateIds: discovery.urlCandidates.map(candidateId),
            rootOnly: discovery.rootOnly,
          })),
    expertNote:
      decision.primaryClass === "REJECTED" || selected.expertNote === null
        ? null
        : {
            noteType: selected.expertNote.noteType,
            title: selected.expertNote.title,
            summary: selected.expertNote.summary,
            evidenceOrigin: selected.expertNote.evidenceOrigin,
            evidenceSpanIds: idsFor(selected.expertNote.evidenceSpans),
            relatedSubjectNames: selected.expertNote.relatedSubjectNames,
            qualifiers: selected.expertNote.qualifiers,
          },
    reviewFlags: decision.primaryClass === "REJECTED" ? [] : normalizedFlags,
    rejectionReason,
    holdout: holdoutIds.has(aRow.commentId),
    annotation: {
      annotatorA: { id: "A", primaryClass: aRow.primaryClass },
      annotatorB: { id: "B", primaryClass: bRow.primaryClass },
      adjudication: {
        adjudicator: "codex-root",
        disagreement: disagreed,
        rationale: decision.rationale,
      },
    },
  };
});

await writeFile(
  path.join(root, "evaluation/gold-v1.jsonl"),
  `${gold.map((row) => JSON.stringify(row)).join("\n")}\n`,
  "utf8",
);
console.log(
  JSON.stringify(
    {
      rows: gold.length,
      counts: Object.fromEntries(
        (["DISCOVERY", "EXPERT_NOTE", "REJECTED"] as const).map(
          (primaryClass) => [
            primaryClass,
            gold.filter((row) => row.primaryClass === primaryClass).length,
          ],
        ),
      ),
    },
    null,
    2,
  ),
);
