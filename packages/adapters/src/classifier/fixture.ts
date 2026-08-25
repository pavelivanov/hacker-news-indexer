import type {
  ClassifierPort,
  ClassifierRequest,
  ClassifierResponse,
} from "@hn-knowledge/ports";

export interface FixtureClassifierOptions {
  readonly outputs: ReadonlyMap<number, unknown>;
  readonly provider?: string;
  readonly modelId?: string;
  readonly modelConfigId?: string;
  readonly latencyMs?: number;
}

export class FixtureClassifier implements ClassifierPort {
  readonly provider: string;
  readonly modelId: string;
  readonly modelConfigId: string;
  readonly requests: ClassifierRequest[] = [];
  private readonly outputs: ReadonlyMap<number, unknown>;
  private readonly latencyMs: number;

  constructor(options: FixtureClassifierOptions) {
    this.outputs = options.outputs;
    this.provider = options.provider ?? "fixture";
    this.modelId = options.modelId ?? "fixture-replay-v1";
    this.modelConfigId = options.modelConfigId ?? "fixture-replay-v1";
    this.latencyMs = options.latencyMs ?? 0;
  }

  classify(request: ClassifierRequest): Promise<ClassifierResponse> {
    this.requests.push(request);
    const output = this.outputs.get(Number(request.input.selectedCommentId));
    if (output === undefined) {
      throw new TypeError("FIXTURE_CLASSIFICATION_MISSING");
    }
    const rawOutput =
      typeof output === "string" ? output : JSON.stringify(output);
    return Promise.resolve({
      rawOutput,
      provider: this.provider,
      modelId: this.modelId,
      modelConfigId: this.modelConfigId,
      latencyMs: this.latencyMs,
      inputTokens: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      outputTokens: null,
    });
  }
}
