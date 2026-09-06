import Type from "typebox";
import Schema from "typebox/schema";

export const FeedControlV1Schema = Type.Object(
  {
    action: Type.Union([
      Type.Literal("sync"),
      Type.Literal("pause"),
      Type.Literal("resume"),
    ]),
  },
  { additionalProperties: false },
);
export const FeedRetryV1Schema = Type.Object(
  {
    command_key: Type.String({
      minLength: 1,
      maxLength: 160,
      pattern: "^[A-Za-z0-9._:-]+$",
    }),
  },
  { additionalProperties: false },
);
export type FeedControlV1 = Type.Static<typeof FeedControlV1Schema>;
export const FeedSettingsV1Schema = Type.Object(
  {
    interval_minutes: Type.Integer({ minimum: 1, maximum: 1440 }),
    daily_request_limit: Type.Integer({ minimum: 1, maximum: 1000 }),
    expected_version: Type.Integer({ minimum: 0, maximum: 2147483646 }),
    command_key: Type.String({
      minLength: 1,
      maxLength: 160,
      pattern: "^[A-Za-z0-9._:-]+$",
    }),
  },
  { additionalProperties: false },
);
export type FeedSettingsV1 = Type.Static<typeof FeedSettingsV1Schema>;
const settingsValidator = Schema.Compile(FeedSettingsV1Schema);
export const parseFeedSettingsV1 = (value: unknown): FeedSettingsV1 => {
  if (!settingsValidator.Check(value))
    throw new TypeError("Invalid feed settings");
  return value;
};
const controlValidator = Schema.Compile(FeedControlV1Schema);
const retryValidator = Schema.Compile(FeedRetryV1Schema);
export const parseFeedControlV1 = (value: unknown): FeedControlV1 => {
  if (!controlValidator.Check(value))
    throw new TypeError("Invalid processing control");
  return value;
};
export const parseFeedRetryV1 = (
  value: unknown,
): Type.Static<typeof FeedRetryV1Schema> => {
  if (!retryValidator.Check(value))
    throw new TypeError("Invalid processing retry");
  return value;
};
