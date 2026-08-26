export const PIPELINE_METRIC_NAMES = [
  "ingestion_messages_total",
  "ingestion_gap_total",
  "hn_resolution_depth",
  "hn_cache_hit_total",
  "displayed_root_mismatch_total",
  "multipart_incomplete_total",
  "classification_total",
  "classification_schema_error_total",
  "classification_latency_seconds",
  "url_candidate_rejected_total",
  "review_queue_depth",
  "review_queue_oldest_age_seconds",
  "feed_root_concentration",
  "export_total",
  "pipeline_failure_total",
] as const;

export type PipelineMetricName = (typeof PIPELINE_METRIC_NAMES)[number];

type MetricKind = "counter" | "gauge" | "histogram";

interface MetricDefinition {
  readonly kind: MetricKind;
  readonly help: string;
  readonly buckets?: readonly number[];
}

const DEFINITIONS: Readonly<Record<PipelineMetricName, MetricDefinition>> = {
  ingestion_messages_total: {
    kind: "counter",
    help: "Selection messages observed by ingestion.",
  },
  ingestion_gap_total: {
    kind: "counter",
    help: "Missing message IDs in requested ingestion ranges.",
  },
  hn_resolution_depth: {
    kind: "histogram",
    help: "HN parent-chain depth for resolved selected comments.",
    buckets: [0, 1, 2, 4, 8, 16, 32, 64],
  },
  hn_cache_hit_total: {
    kind: "counter",
    help: "HN parent-chain cache hits.",
  },
  displayed_root_mismatch_total: {
    kind: "counter",
    help: "Displayed story references that differ from resolved roots.",
  },
  multipart_incomplete_total: {
    kind: "counter",
    help: "Incomplete or conflicting multipart reconstructions.",
  },
  classification_total: {
    kind: "counter",
    help: "Classification attempts.",
  },
  classification_schema_error_total: {
    kind: "counter",
    help: "Classifier responses rejected by the strict schema.",
  },
  classification_latency_seconds: {
    kind: "histogram",
    help: "End-to-end classification latency in seconds.",
    buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  },
  url_candidate_rejected_total: {
    kind: "counter",
    help: "URL candidates rejected before classification.",
  },
  review_queue_depth: {
    kind: "gauge",
    help: "Open review tasks.",
  },
  review_queue_oldest_age_seconds: {
    kind: "gauge",
    help: "Age of the oldest open review task in seconds.",
  },
  feed_root_concentration: {
    kind: "gauge",
    help: "Largest resolved-root share in the last served feed page.",
  },
  export_total: {
    kind: "counter",
    help: "Successful FindThatProject export acknowledgements.",
  },
  pipeline_failure_total: {
    kind: "counter",
    help: "Retryable or terminal pipeline failures.",
  },
};

interface HistogramState {
  count: number;
  sum: number;
  readonly buckets: number[];
}

export interface PipelineMetrics {
  readonly increment: (name: PipelineMetricName, amount?: number) => void;
  readonly set: (name: PipelineMetricName, value: number) => void;
  readonly observe: (name: PipelineMetricName, value: number) => void;
  readonly value: (name: PipelineMetricName) => number;
  readonly render: () => string;
}

const finiteNonNegative = (value: number, field: string): number => {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be finite and non-negative`);
  }
  return value;
};

export const createPipelineMetrics = (): PipelineMetrics => {
  const values = new Map<PipelineMetricName, number>();
  const histograms = new Map<PipelineMetricName, HistogramState>();
  for (const name of PIPELINE_METRIC_NAMES) {
    const definition = DEFINITIONS[name];
    values.set(name, 0);
    if (definition.kind === "histogram") {
      histograms.set(name, {
        count: 0,
        sum: 0,
        buckets: (definition.buckets ?? []).map(() => 0),
      });
    }
  }

  return {
    increment(name, amount = 1) {
      const definition = DEFINITIONS[name];
      if (definition.kind !== "counter") {
        throw new TypeError(`${name} is not a counter`);
      }
      values.set(
        name,
        (values.get(name) ?? 0) + finiteNonNegative(amount, "amount"),
      );
    },
    set(name, value) {
      const definition = DEFINITIONS[name];
      if (definition.kind !== "gauge") {
        throw new TypeError(`${name} is not a gauge`);
      }
      values.set(name, finiteNonNegative(value, "value"));
    },
    observe(name, value) {
      const definition = DEFINITIONS[name];
      if (definition.kind !== "histogram") {
        throw new TypeError(`${name} is not a histogram`);
      }
      const observed = finiteNonNegative(value, "value");
      const state = histograms.get(name);
      if (state === undefined) {
        throw new TypeError(`Histogram state missing for ${name}`);
      }
      state.count += 1;
      state.sum += observed;
      for (const [index, upperBound] of (definition.buckets ?? []).entries()) {
        if (observed <= upperBound) {
          state.buckets[index] = (state.buckets[index] ?? 0) + 1;
        }
      }
      values.set(name, state.count);
    },
    value: (name) => values.get(name) ?? 0,
    render() {
      const lines: string[] = [];
      for (const name of PIPELINE_METRIC_NAMES) {
        const definition = DEFINITIONS[name];
        lines.push(`# HELP ${name} ${definition.help}`);
        lines.push(`# TYPE ${name} ${definition.kind}`);
        if (definition.kind !== "histogram") {
          lines.push(`${name} ${values.get(name) ?? 0}`);
          continue;
        }
        const state = histograms.get(name);
        if (state === undefined) {
          continue;
        }
        for (const [index, upperBound] of (
          definition.buckets ?? []
        ).entries()) {
          lines.push(
            `${name}_bucket{le="${upperBound}"} ${state.buckets[index] ?? 0}`,
          );
        }
        lines.push(`${name}_bucket{le="+Inf"} ${state.count}`);
        lines.push(`${name}_sum ${state.sum}`);
        lines.push(`${name}_count ${state.count}`);
      }
      return `${lines.join("\n")}\n`;
    },
  };
};

export const pipelineMetrics = createPipelineMetrics();
