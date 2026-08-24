import { describe, expect, it, vi } from "vitest";

import {
  OpenAiClassifier,
  toOpenAiStructuredOutputSchema,
  type OpenAiFetch,
} from "@hn-knowledge/adapters";
import { ClassificationV1Schema } from "@hn-knowledge/contracts";
import { hnItemId } from "@hn-knowledge/domain";
import type { ClassifierRequest } from "@hn-knowledge/ports";

const request = (timeoutMs = 1_000): ClassifierRequest => ({
  input: {
    schemaVersion: "classification-input.v1",
    selectedCommentId: hnItemId(100),
    rootId: hnItemId(200),
    documents: [],
    urlCandidates: [],
    truncation: [],
  },
  prompt: "Classify only the supplied bounded input.",
  promptVersion: "classification-prompt.v1",
  promptHash: "prompt-hash",
  schemaVersion: "classification.v1",
  outputSchema: ClassificationV1Schema as unknown as Readonly<
    Record<string, unknown>
  >,
  timeoutMs,
});

const completedResponse = (rawOutput: string): Response =>
  new Response(
    JSON.stringify({
      id: "resp_test",
      status: "completed",
      model: "gpt-5.6-luna",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: rawOutput }],
        },
      ],
      usage: { input_tokens: 123, output_tokens: 45, total_tokens: 168 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("OpenAI classifier adapter", () => {
  it("uses the Responses API with strict schema output and no capabilities", async () => {
    const rawOutput = '{"schema_version":"classification.v1"}';
    const fetcher = vi.fn<OpenAiFetch>(async () =>
      completedResponse(rawOutput),
    );
    const classifier = new OpenAiClassifier({
      apiToken: "test-secret-token",
      modelId: "gpt-5.6-luna",
      reasoningEffort: "low",
      fetch: fetcher,
    });

    await expect(classifier.classify(request())).resolves.toMatchObject({
      rawOutput,
      provider: "openai",
      modelId: "gpt-5.6-luna",
      inputTokens: 123,
      outputTokens: 45,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer test-secret-token",
      "content-type": "application/json",
    });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "gpt-5.6-luna",
      reasoning: { effort: "low" },
      tools: [],
      parallel_tool_calls: false,
      max_output_tokens: 8_192,
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "classification_v1",
          strict: true,
        },
        verbosity: "low",
      },
    });
    expect(String(body["input"])).toContain("classification-input.v1");
    expect(JSON.stringify(body)).not.toContain("test-secret-token");
    const format = (body["text"] as { format: { schema: unknown } }).format;
    const schemaText = JSON.stringify(format.schema);
    expect(schemaText).not.toContain('"$id"');
    expect(schemaText).not.toContain('"minLength"');
    expect(schemaText).not.toContain('"maxLength"');
    expect(schemaText).not.toContain('"uniqueItems"');
    expect(schemaText).toContain('"enum":["classification.v1"]');
    expect(JSON.stringify(ClassificationV1Schema)).toContain('"$id"');
  });

  it("maps authentication, rate-limit, and provider failures", async () => {
    const cases = [
      [401, null, "CLASSIFIER_AUTH", false, null],
      [429, "2", "CLASSIFIER_RATE_LIMIT", true, 2_000],
      [503, null, "CLASSIFIER_PROVIDER_5XX", true, null],
      [400, null, "CLASSIFIER_CONFIG", false, null],
    ] as const;
    for (const [status, retryAfter, code, retryable, retryAfterMs] of cases) {
      const headers = retryAfter === null ? {} : { "retry-after": retryAfter };
      const classifier = new OpenAiClassifier({
        apiToken: "test-token",
        modelId: "gpt-5.6-luna",
        fetch: async () => new Response("{}", { status, headers }),
      });

      await expect(classifier.classify(request())).rejects.toMatchObject({
        code,
        retryable,
        retryAfterMs,
      });
    }
  });

  it("fails closed for malformed, incomplete, or refused responses", async () => {
    const responses = [
      new Response("not json", { status: 200 }),
      new Response(JSON.stringify({ status: "incomplete", output: [] }), {
        status: 200,
      }),
      new Response(
        JSON.stringify({
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "refusal", refusal: "Cannot comply" }],
            },
          ],
        }),
        { status: 200 },
      ),
    ];
    for (const response of responses) {
      const classifier = new OpenAiClassifier({
        apiToken: "test-token",
        modelId: "gpt-5.6-luna",
        fetch: async () => response,
      });

      await expect(classifier.classify(request())).rejects.toMatchObject({
        code: "CLASSIFIER_INVALID_RESPONSE",
        retryable: false,
      });
    }
  });

  it("aborts at the application-provided deadline", async () => {
    const fetcher: OpenAiFetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      });
    const classifier = new OpenAiClassifier({
      apiToken: "test-token",
      modelId: "gpt-5.6-luna",
      fetch: fetcher,
    });

    await expect(classifier.classify(request(10))).rejects.toMatchObject({
      code: "CLASSIFIER_TIMEOUT",
      retryable: true,
    });
  });

  it("does not mutate the application-owned schema during adaptation", () => {
    const original = {
      $id: "example",
      type: "object",
      properties: { value: { const: "x", minLength: 1 } },
      required: ["value"],
      additionalProperties: false,
    } as const;

    expect(toOpenAiStructuredOutputSchema(original)).toEqual({
      type: "object",
      properties: { value: { enum: ["x"] } },
      required: ["value"],
      additionalProperties: false,
    });
    expect(original.properties.value).toEqual({ const: "x", minLength: 1 });
  });
});
