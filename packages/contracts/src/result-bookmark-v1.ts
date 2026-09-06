import Type from "typebox";
import Schema from "typebox/schema";

export const ResultBookmarkV1Schema = Type.Object(
  {
    bookmarked: Type.Boolean(),
    expected_version: Type.Integer({ minimum: 0, maximum: 2147483646 }),
    command_key: Type.String({
      minLength: 1,
      maxLength: 160,
      pattern: "^[A-Za-z0-9._:-]+$",
    }),
  },
  { additionalProperties: false },
);
export type ResultBookmarkV1 = Type.Static<typeof ResultBookmarkV1Schema>;
const validator = Schema.Compile(ResultBookmarkV1Schema);
export const parseResultBookmarkV1 = (value: unknown): ResultBookmarkV1 => {
  if (!validator.Check(value)) throw new TypeError("Invalid bookmark request");
  return value;
};
