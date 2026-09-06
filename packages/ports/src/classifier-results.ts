import type { ResultCategory, ResultCorrection } from "@hn-knowledge/domain";
import type { BoundedClassifierInput } from "./classifier.js";

export type ResultsFilter =
  | "all"
  | "discovery"
  | "expert_note"
  | "skipped"
  | "uncertain"
  | "corrected"
  | "saved";
export interface ResultFeedbackRecord {
  readonly id: string;
  readonly version: number;
  readonly values: ResultCorrection;
  readonly actorId: string;
  readonly createdAt: Date;
}
export interface ClassifierResultRecord {
  readonly id: string;
  readonly commentId: number;
  readonly createdAt: Date;
  readonly category: ResultCategory | "FAILED";
  readonly title: string;
  readonly summary: string;
  readonly feedbackVersion: number;
  readonly bookmarked: boolean;
  readonly bookmarkVersion: number;
  readonly input: BoundedClassifierInput;
  readonly output: unknown;
  readonly errorCode: string | null;
  readonly inputHash: string;
  readonly provider: string;
  readonly modelId: string;
  readonly modelConfigId: string;
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly available: boolean;
  readonly feedback: readonly ResultFeedbackRecord[];
}
export interface ClassifierResultsRepository {
  list(
    filter: ResultsFilter,
    after: { createdAt: Date; id: string } | null,
    query: string,
  ): Promise<readonly ClassifierResultRecord[]>;
  get(id: string): Promise<ClassifierResultRecord | null>;
  bookmark(input: {
    id: string;
    expectedVersion: number;
    commandKey: string;
    requestHash: string;
    bookmarked: boolean;
  }): Promise<{ bookmarked: boolean; version: number; replayed: boolean }>;
  capture(input: {
    runId: string;
    source: BoundedClassifierInput;
    output: unknown;
    category: ResultCategory | "FAILED";
    title: string;
    summary: string;
    errorCode: string | null;
  }): Promise<void>;
  correct(input: {
    id: string;
    expectedVersion: number;
    commandKey: string;
    requestHash: string;
    actorId: string;
    values: ResultCorrection;
  }): Promise<{ feedback: ResultFeedbackRecord; replayed: boolean }>;
}
