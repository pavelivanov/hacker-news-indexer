import Type from "typebox";
import Schema from "typebox/schema";

import {
  ClassificationV1Schema,
  type ClassificationV1,
} from "./classification-v1.js";

type PartialTree<T> = T extends readonly (infer Item)[]
  ? PartialTree<Item>[]
  : T extends object
    ? { [Key in keyof T]?: PartialTree<T[Key]> }
    : T;
export type ManualDraftPayload = PartialTree<ClassificationV1>;

// Preserve the frozen output contract's vocabulary, upper bounds and exact
// objects, while allowing an unfinished form (including empty text/arrays).
const partialSchema = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(partialSchema);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          (key !== "required" ||
            !Array.isArray((value as Record<string, unknown>)[key])) &&
          key !== "$id",
      )
      .map(([key, entry]) => [
        key,
        key === "minLength" || key === "minItems" ? 0 : partialSchema(entry),
      ]),
  );
};

export const ManualDraftPayloadValidator = Schema.Compile(
  partialSchema(ClassificationV1Schema) as Type.TSchema,
);

export const parseManualDraftPayload = (value: unknown): ManualDraftPayload => {
  if (
    !ManualDraftPayloadValidator.Check(value) ||
    JSON.stringify(value).length > 65_536
  ) {
    throw new TypeError("Invalid manual draft payload");
  }
  return value as ManualDraftPayload;
};

export const ManualVersionSchema = Type.Integer({
  minimum: 1,
  maximum: 2_147_483_646,
});
export const ManualSourceHashSchema = Type.String({
  pattern: "^[a-f0-9]{64}$",
});
export const ManualSaveSchema = Type.Object(
  {
    expected_version: ManualVersionSchema,
    source_hash: ManualSourceHashSchema,
    payload: partialSchema(ClassificationV1Schema) as Type.TSchema,
  },
  { additionalProperties: false },
);
export const ManualRebaseSchema = Type.Object(
  {
    expected_version: ManualVersionSchema,
  },
  { additionalProperties: false },
);
export const ManualFinalizeSchema = Type.Object(
  {
    expected_version: ManualVersionSchema,
    source_hash: ManualSourceHashSchema,
    command_key: Type.String({ pattern: "^[A-Za-z0-9._:-]{1,160}$" }),
    reason: Type.String({ minLength: 1, maxLength: 1_000 }),
  },
  { additionalProperties: false },
);

export interface ManualSaveV1 {
  readonly expected_version: number;
  readonly source_hash: string;
  readonly payload: ManualDraftPayload;
}
export interface ManualFinalizeV1 {
  readonly expected_version: number;
  readonly source_hash: string;
  readonly command_key: string;
  readonly reason: string;
}
export interface ManualDraftV1 {
  readonly id: string;
  readonly comment_id: number;
  readonly payload: ManualDraftPayload;
  readonly version: number;
  readonly source_hash: string;
  readonly state: "DRAFT" | "APPROVED" | "REJECTED";
  readonly actor_id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly decision_id: string | null;
}

export interface ManualFinalizeResultV1 {
  readonly draft: ManualDraftV1;
  readonly decision_id: string;
  readonly review_task_id: string;
  readonly replayed: boolean;
  readonly warnings: readonly string[];
}

const saveValidator = Schema.Compile(ManualSaveSchema);
const rebaseValidator = Schema.Compile(ManualRebaseSchema);
export const parseManualRebase = (value: unknown): number => {
  if (!rebaseValidator.Check(value)) throw new TypeError("Invalid rebase");
  return value.expected_version;
};

export const parseManualSave = (value: unknown): ManualSaveV1 => {
  if (!saveValidator.Check(value)) throw new TypeError("Invalid draft save");
  const request = value as ManualSaveV1;
  parseManualDraftPayload(request.payload);
  return request;
};
const finalizeValidator = Schema.Compile(ManualFinalizeSchema);
export const parseManualFinalize = (value: unknown): ManualFinalizeV1 => {
  if (!finalizeValidator.Check(value))
    throw new TypeError("Invalid draft finalization");
  const request = value as ManualFinalizeV1;
  if (!request.reason.trim()) throw new TypeError("Review reason is required");
  return { ...request, reason: request.reason.trim() };
};
