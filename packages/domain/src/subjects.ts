import { URL } from "node:url";

import type {
  ContentDecisionId,
  DiscoveryId,
  ExpertNoteId,
  HnItemId,
  SubjectId,
} from "./identities.js";

export const SUBJECT_TYPES = [
  "PROJECT",
  "TOOL",
  "LIBRARY",
  "SERVICE",
  "PRODUCT",
  "FEATURE",
  "PLUGIN",
  "AGENT_SKILL",
  "GUIDE",
  "RESOURCE",
] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

export const SUBJECT_IDENTITY_BASES = [
  "ECOSYSTEM_COORDINATE",
  "CANONICAL_URL",
  "OFFICIAL_DOMAIN",
  "NAME_CONTEXT",
] as const;
export type SubjectIdentityBasis = (typeof SUBJECT_IDENTITY_BASES)[number];

export const SUBJECT_MATCH_KINDS = [
  "AUTO_MERGE",
  "REVIEW",
  "DISTINCT",
] as const;
export type SubjectMatchKind = (typeof SUBJECT_MATCH_KINDS)[number];

export const SUBJECT_LIFECYCLE_STATES = [
  "ACTIVE",
  "MERGED",
  "TOMBSTONED",
] as const;
export type SubjectLifecycleState = (typeof SUBJECT_LIFECYCLE_STATES)[number];

export const MATERIALIZED_CONTENT_STATUSES = [
  "REVIEW_PENDING",
  "APPROVED",
  "REJECTED",
  "SUPERSEDED",
] as const;
export type MaterializedContentStatus =
  (typeof MATERIALIZED_CONTENT_STATUSES)[number];

export const MATERIALIZED_EVIDENCE_ORIGINS = [
  "COMMENT",
  "ROOT_STORY",
  "BOTH",
] as const;
export type MaterializedEvidenceOrigin =
  (typeof MATERIALIZED_EVIDENCE_ORIGINS)[number];

export const EXPERT_NOTE_TYPES = [
  "TECHNICAL_EXPLANATION",
  "CORRECTION",
  "PRODUCT_EXPERIENCE",
  "IMPLEMENTATION_CAVEAT",
  "SECURITY",
  "OPERATIONS",
  "COMPARISON",
  "GUIDE",
] as const;
export type ExpertNoteType = (typeof EXPERT_NOTE_TYPES)[number];

export const URL_NORMALIZATION_ERROR_CODES = [
  "EMPTY",
  "TOO_LONG",
  "INVALID",
  "RELATIVE",
  "UNSUPPORTED_SCHEME",
  "CREDENTIALS_PRESENT",
] as const;
export type UrlNormalizationErrorCode =
  (typeof URL_NORMALIZATION_ERROR_CODES)[number];

export interface NormalizedSubjectUrl {
  readonly rawUrl: string;
  readonly canonicalUrl: string;
  readonly scheme: "http" | "https";
  readonly host: string;
}

export type NormalizeSubjectUrlResult =
  | { readonly ok: true; readonly value: NormalizedSubjectUrl }
  | { readonly ok: false; readonly code: UrlNormalizationErrorCode };

export interface SubjectKeyHasher {
  readonly sha256: (value: string) => string;
}

export interface SubjectIdentityInput {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly subjectType: SubjectType;
  readonly canonicalUrl: string | null;
  readonly verifiedOfficialDomain: string | null;
  readonly disambiguatingRootId: HnItemId | null;
  readonly provenanceKey: string;
}

export interface SubjectIdentity {
  readonly normalizedName: string;
  readonly normalizedAliases: readonly string[];
  readonly subjectType: SubjectType;
  readonly basis: SubjectIdentityBasis;
  readonly dedupKey: string;
  readonly ecosystemCoordinate: string | null;
  readonly canonicalUrl: string | null;
  readonly officialDomain: string | null;
  readonly contextKey: string;
}

export interface SubjectMatchDecision {
  readonly kind: SubjectMatchKind;
  readonly basis: SubjectIdentityBasis | "NAME_ONLY" | null;
}

export interface Subject {
  readonly id: SubjectId;
  readonly type: SubjectType;
  readonly name: string;
  readonly normalizedName: string;
  readonly dedupKey: string;
  readonly identityBasis: SubjectIdentityBasis;
  readonly ecosystemCoordinate: string | null;
  readonly canonicalUrl: string | null;
  readonly officialDomain: string | null;
  readonly contextKey: string;
  readonly lifecycleState: SubjectLifecycleState;
  readonly mergedIntoSubjectId: SubjectId | null;
  readonly createdFromDecisionId: ContentDecisionId;
  readonly aliases: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface Discovery {
  readonly id: DiscoveryId;
  readonly subjectId: SubjectId;
  readonly resolvedRootId: HnItemId | null;
  readonly identityKey: string;
  readonly rootStoryOnly: boolean;
  readonly extractionVersion: string;
  readonly status: MaterializedContentStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ExpertNote {
  readonly id: ExpertNoteId;
  readonly selectedCommentId: HnItemId;
  readonly contentDecisionId: ContentDecisionId;
  readonly noteType: ExpertNoteType;
  readonly title: string;
  readonly summary: string;
  readonly relatedSubjectNames: readonly string[];
  readonly evidenceOrigin: MaterializedEvidenceOrigin;
  readonly confidence: number;
  readonly status: MaterializedContentStatus;
  readonly extractionVersion: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref_src",
  "utm_campaign",
  "utm_content",
  "utm_medium",
  "utm_source",
  "utm_term",
]);

const boundedText = (value: string, field: string, maximum: number): string => {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new TypeError(`${field} must contain 1 to ${maximum} characters`);
  }
  return normalized;
};

export const normalizeSubjectName = (value: string): string =>
  boundedText(value, "subject name", 160).toLocaleLowerCase("en-US");

const normalizedNames = (
  name: string,
  aliases: readonly string[],
): readonly string[] => {
  if (aliases.length > 10) {
    throw new TypeError("subject aliases must not exceed 10 entries");
  }
  const primary = normalizeSubjectName(name);
  return [...new Set([primary, ...aliases.map(normalizeSubjectName)])].sort();
};

export const normalizeSubjectUrl = (
  rawUrl: string,
): NormalizeSubjectUrlResult => {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: "EMPTY" };
  }
  if (trimmed.length > 2_048) {
    return { ok: false, code: "TOO_LONG" };
  }
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(trimmed)) {
    return { ok: false, code: "RELATIVE" };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, code: "INVALID" };
  }
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    return { ok: false, code: "UNSUPPORTED_SCHEME" };
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { ok: false, code: "CREDENTIALS_PRESENT" };
  }
  if (parsed.hostname.length === 0) {
    return { ok: false, code: "INVALID" };
  }
  parsed.protocol = `${scheme}:`;
  parsed.hostname = parsed.hostname.toLowerCase();
  if (
    (scheme === "http" && parsed.port === "80") ||
    (scheme === "https" && parsed.port === "443")
  ) {
    parsed.port = "";
  }
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMETERS.has(key.toLowerCase())) {
      parsed.searchParams.delete(key);
    }
  }
  return {
    ok: true,
    value: {
      rawUrl,
      canonicalUrl: parsed.href,
      scheme,
      host: parsed.hostname,
    },
  };
};

const pathParts = (url: URL): readonly string[] =>
  url.pathname.split("/").filter((part) => part.length > 0);

const ecosystemCoordinate = (canonicalUrl: string): string | null => {
  const parsed = new URL(canonicalUrl);
  const host = parsed.hostname.toLowerCase();
  const parts = pathParts(parsed);
  if (
    (host === "github.com" || host === "www.github.com") &&
    parts.length >= 2
  ) {
    const owner = parts[0]?.toLowerCase();
    const repository = parts[1]?.replace(/\.git$/iu, "").toLowerCase();
    return owner === undefined || repository === undefined
      ? null
      : `github:${owner}/${repository}`;
  }
  if (
    (host === "npmjs.com" || host === "www.npmjs.com") &&
    parts[0] === "package" &&
    parts.length >= 2
  ) {
    const packageName = (
      parts[1]?.startsWith("@") ? parts.slice(1, 3) : parts.slice(1, 2)
    )
      .join("/")
      .toLowerCase();
    return `npm:${packageName}`;
  }
  if (host === "pypi.org" && parts[0] === "project" && parts[1] !== undefined) {
    return `pypi:${parts[1].toLowerCase()}`;
  }
  if (host === "crates.io" && parts[0] === "crates" && parts[1] !== undefined) {
    return `crates:${parts[1].toLowerCase()}`;
  }
  return null;
};

const officialDomain = (value: string | null): string | null => {
  if (value === null) {
    return null;
  }
  const normalized = boundedText(value, "verified official domain", 253)
    .toLowerCase()
    .replace(/\.$/u, "");
  let parsed: URL;
  try {
    parsed = new URL(`https://${normalized}/`);
  } catch {
    throw new TypeError("verified official domain is invalid");
  }
  if (
    parsed.hostname !== normalized ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.port.length > 0
  ) {
    throw new TypeError("verified official domain is invalid");
  }
  return parsed.hostname;
};

const contextKey = (input: SubjectIdentityInput): string => {
  const domain = officialDomain(input.verifiedOfficialDomain);
  if (domain !== null) {
    return `domain:${domain}`;
  }
  if (input.disambiguatingRootId !== null) {
    return `root:${input.disambiguatingRootId}`;
  }
  return `provenance:${boundedText(input.provenanceKey, "provenance key", 256)}`;
};

const digestKey = (
  hasher: SubjectKeyHasher,
  basis: SubjectIdentityBasis,
  value: string,
): string =>
  `${basis.toLowerCase()}:${hasher.sha256(`${basis}\u0000${value}`)}`;

export const createSubjectIdentity = (
  input: SubjectIdentityInput,
  hasher: SubjectKeyHasher,
): SubjectIdentity => {
  const normalizedName = normalizeSubjectName(input.name);
  const names = normalizedNames(input.name, input.aliases);
  const normalizedAliases = names.filter((name) => name !== normalizedName);
  const normalizedUrl =
    input.canonicalUrl === null
      ? null
      : normalizeSubjectUrl(input.canonicalUrl);
  if (normalizedUrl !== null && !normalizedUrl.ok) {
    throw new TypeError(
      `canonical subject URL is invalid: ${normalizedUrl.code}`,
    );
  }
  const canonicalUrl = normalizedUrl?.value.canonicalUrl ?? null;
  const coordinate =
    canonicalUrl === null ? null : ecosystemCoordinate(canonicalUrl);
  const domain = officialDomain(input.verifiedOfficialDomain);
  const context = contextKey(input);
  const basis: SubjectIdentityBasis =
    coordinate !== null
      ? "ECOSYSTEM_COORDINATE"
      : canonicalUrl !== null
        ? "CANONICAL_URL"
        : domain !== null
          ? "OFFICIAL_DOMAIN"
          : "NAME_CONTEXT";
  const value =
    coordinate ??
    canonicalUrl ??
    domain ??
    `${normalizedName}\u0000${input.subjectType}\u0000${context}`;
  return {
    normalizedName,
    normalizedAliases,
    subjectType: input.subjectType,
    basis,
    dedupKey: digestKey(hasher, basis, value),
    ecosystemCoordinate: coordinate,
    canonicalUrl,
    officialDomain: domain,
    contextKey: context,
  };
};

const namesOverlap = (
  left: SubjectIdentity,
  right: SubjectIdentity,
): boolean => {
  const leftNames = new Set([left.normalizedName, ...left.normalizedAliases]);
  return [right.normalizedName, ...right.normalizedAliases].some((name) =>
    leftNames.has(name),
  );
};

export const compareSubjectIdentities = (
  left: SubjectIdentity,
  right: SubjectIdentity,
): SubjectMatchDecision => {
  if (left.dedupKey === right.dedupKey) {
    return { kind: "AUTO_MERGE", basis: left.basis };
  }
  if (left.subjectType !== right.subjectType || !namesOverlap(left, right)) {
    return { kind: "DISTINCT", basis: null };
  }
  const leftDomain =
    left.officialDomain ??
    (left.canonicalUrl === null ? null : new URL(left.canonicalUrl).hostname);
  const rightDomain =
    right.officialDomain ??
    (right.canonicalUrl === null ? null : new URL(right.canonicalUrl).hostname);
  if (
    leftDomain !== null &&
    rightDomain !== null &&
    leftDomain !== rightDomain
  ) {
    return { kind: "DISTINCT", basis: null };
  }
  return { kind: "REVIEW", basis: "NAME_ONLY" };
};
