import Type from "typebox";
import Schema from "typebox/schema";

export const ClassifierFeedbackV1Schema = Type.Object(
  {
    expected_version: Type.Integer({ minimum: 0, maximum: 2_147_483_646 }),
    command_key: Type.String({ pattern: "^[A-Za-z0-9._:-]{1,160}$" }),
    category: Type.Union([
      Type.Literal("DISCOVERY"),
      Type.Literal("EXPERT_NOTE"),
      Type.Literal("REJECTED"),
      Type.Literal("REVIEW"),
    ]),
    title: Type.String({ maxLength: 240 }),
    summary: Type.String({ maxLength: 8000 }),
    issue: Type.Union([
      Type.Literal("WRONG_CATEGORY"),
      Type.Literal("INACCURATE_SUMMARY"),
      Type.Literal("NOT_USEFUL"),
      Type.Literal("MISSING_CONTEXT"),
      Type.Literal("OTHER"),
    ]),
    explanation: Type.String({ maxLength: 2000 }),
  },
  { additionalProperties: false },
);
export type ClassifierFeedbackV1 = Type.Static<
  typeof ClassifierFeedbackV1Schema
>;
const validator = Schema.Compile(ClassifierFeedbackV1Schema);
export const parseClassifierFeedbackV1 = (
  value: unknown,
): ClassifierFeedbackV1 => {
  if (!validator.Check(value)) throw new TypeError("Invalid correction");
  const result = {
    ...value,
    title: value.title.trim(),
    summary: value.summary.trim(),
    explanation: value.explanation.trim(),
  };
  if (
    ["DISCOVERY", "EXPERT_NOTE"].includes(result.category) &&
    (!result.title || !result.summary)
  )
    throw new TypeError("Retained results need a title and summary");
  return result;
};
