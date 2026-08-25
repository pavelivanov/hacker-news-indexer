export type EvaluationPrimaryClass = "DISCOVERY" | "EXPERT_NOTE" | "REJECTED";
export type EvaluationPrediction =
  EvaluationPrimaryClass | "REVIEW" | "INVALID";

export const EVALUATION_PRIMARY_CLASSES = [
  "DISCOVERY",
  "EXPERT_NOTE",
  "REJECTED",
] as const satisfies readonly EvaluationPrimaryClass[];
export const EVALUATION_PREDICTIONS = [
  ...EVALUATION_PRIMARY_CLASSES,
  "REVIEW",
  "INVALID",
] as const satisfies readonly EvaluationPrediction[];

export type EvaluationConfusionMatrix = Record<
  EvaluationPrimaryClass,
  Record<EvaluationPrediction, number>
>;

export interface PerClassMetrics {
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
}

export interface ClassificationMetrics {
  readonly classMetrics: Readonly<
    Record<EvaluationPrimaryClass, PerClassMetrics>
  >;
  readonly macroF1: number;
  readonly overallClassMetrics: Readonly<
    Record<EvaluationPrimaryClass, PerClassMetrics>
  >;
  readonly overallMacroF1: number;
  readonly classifiedRows: number;
  readonly abstainedRows: number;
  readonly classificationCoverage: number;
  readonly classifiedAccuracy: number;
}

const ratio = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : numerator / denominator;

const f1 = (precision: number, recall: number): number =>
  precision + recall === 0
    ? 0
    : (2 * precision * recall) / (precision + recall);

const metricsFor = (
  matrix: EvaluationConfusionMatrix,
  includeAbstentionsAsFalseNegatives: boolean,
): Readonly<Record<EvaluationPrimaryClass, PerClassMetrics>> =>
  Object.fromEntries(
    EVALUATION_PRIMARY_CLASSES.map((label) => {
      const truePositive = matrix[label][label];
      const falsePositive = EVALUATION_PRIMARY_CLASSES.filter(
        (expected) => expected !== label,
      ).reduce((total, expected) => total + matrix[expected][label], 0);
      const falseNegativeLabels = includeAbstentionsAsFalseNegatives
        ? EVALUATION_PREDICTIONS
        : EVALUATION_PRIMARY_CLASSES;
      const falseNegative = falseNegativeLabels
        .filter((predicted) => predicted !== label)
        .reduce((total, predicted) => total + matrix[label][predicted], 0);
      const precision = ratio(truePositive, truePositive + falsePositive);
      const recall = ratio(truePositive, truePositive + falseNegative);
      return [label, { precision, recall, f1: f1(precision, recall) }];
    }),
  ) as Readonly<Record<EvaluationPrimaryClass, PerClassMetrics>>;

const macro = (
  metrics: Readonly<Record<EvaluationPrimaryClass, PerClassMetrics>>,
): number =>
  EVALUATION_PRIMARY_CLASSES.reduce(
    (total, label) => total + metrics[label].f1,
    0,
  ) / EVALUATION_PRIMARY_CLASSES.length;

export const calculateClassificationMetrics = (
  matrix: EvaluationConfusionMatrix,
): ClassificationMetrics => {
  const classMetrics = metricsFor(matrix, false);
  const overallClassMetrics = metricsFor(matrix, true);
  let classifiedRows = 0;
  let correctRows = 0;
  let abstainedRows = 0;
  for (const expected of EVALUATION_PRIMARY_CLASSES) {
    for (const predicted of EVALUATION_PRIMARY_CLASSES) {
      const count = matrix[expected][predicted];
      classifiedRows += count;
      if (expected === predicted) {
        correctRows += count;
      }
    }
    abstainedRows += matrix[expected].REVIEW + matrix[expected].INVALID;
  }
  const rows = classifiedRows + abstainedRows;
  return {
    classMetrics,
    macroF1: macro(classMetrics),
    overallClassMetrics,
    overallMacroF1: macro(overallClassMetrics),
    classifiedRows,
    abstainedRows,
    classificationCoverage: ratio(classifiedRows, rows),
    classifiedAccuracy: ratio(correctRows, classifiedRows),
  };
};

export interface ExpectedEvaluationDiscovery {
  readonly subjectType: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly evidenceOrigin: string;
  readonly urlCandidateIds: readonly string[];
}

export interface PredictedEvaluationDiscovery {
  readonly subjectType: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly evidenceOrigin: string;
  readonly urlCandidateIds: readonly string[];
}

export interface ExtractionEvaluationRow {
  readonly expectedDiscoveries: readonly ExpectedEvaluationDiscovery[];
  readonly predictedDiscoveries: readonly PredictedEvaluationDiscovery[];
  readonly expectedExpertNoteOrigin: string | null;
  readonly predictedExpertNoteOrigin: string | null;
}

export interface ExtractionMetrics {
  readonly expectedDiscoveries: number;
  readonly predictedDiscoveries: number;
  readonly matchedDiscoveries: number;
  readonly discoveryExtractionPrecision: number;
  readonly discoveryExtractionRecall: number;
  readonly matchedEvidenceItems: number;
  readonly expectedEvidenceItems: number;
  readonly goldEvidenceOriginAgreement: number;
  readonly goldEvidenceOriginCoverage: number;
  readonly predictedUrlIds: number;
  readonly expectedUrlIds: number;
  readonly correctUrlIds: number;
  readonly urlGroundingPrecision: number;
  readonly urlGroundingRecall: number;
}

const normalizeName = (value: string): string =>
  value.normalize("NFKC").trim().replaceAll(/\s+/gu, " ").toLocaleLowerCase();

const namesFor = (value: {
  readonly name: string;
  readonly aliases: readonly string[];
}): ReadonlySet<string> =>
  new Set([value.name, ...value.aliases].map(normalizeName).filter(Boolean));

const sharesName = (
  expected: ExpectedEvaluationDiscovery,
  predicted: PredictedEvaluationDiscovery,
): boolean => {
  const expectedNames = namesFor(expected);
  return [...namesFor(predicted)].some((name) => expectedNames.has(name));
};

interface DiscoveryMatch {
  readonly expected: ExpectedEvaluationDiscovery;
  readonly predicted: PredictedEvaluationDiscovery;
}

const matchDiscoveries = (
  expected: readonly ExpectedEvaluationDiscovery[],
  predicted: readonly PredictedEvaluationDiscovery[],
): {
  readonly matches: readonly DiscoveryMatch[];
  readonly unmatchedPredicted: readonly PredictedEvaluationDiscovery[];
} => {
  const available = new Set(predicted.map((_value, index) => index));
  const matches: DiscoveryMatch[] = [];
  for (const expectedDiscovery of expected) {
    const candidates = [...available].filter((index) => {
      const predictedDiscovery = predicted[index];
      return (
        predictedDiscovery !== undefined &&
        sharesName(expectedDiscovery, predictedDiscovery)
      );
    });
    candidates.sort((left, right) => {
      const leftType =
        predicted[left]?.subjectType === expectedDiscovery.subjectType ? 1 : 0;
      const rightType =
        predicted[right]?.subjectType === expectedDiscovery.subjectType ? 1 : 0;
      return rightType - leftType || left - right;
    });
    const index = candidates[0];
    const predictedDiscovery =
      index === undefined ? undefined : predicted[index];
    if (index === undefined || predictedDiscovery === undefined) {
      continue;
    }
    available.delete(index);
    matches.push({
      expected: expectedDiscovery,
      predicted: predictedDiscovery,
    });
  }
  return {
    matches,
    unmatchedPredicted: [...available].flatMap((index) => {
      const value = predicted[index];
      return value === undefined ? [] : [value];
    }),
  };
};

export const calculateExtractionMetrics = (
  rows: readonly ExtractionEvaluationRow[],
): ExtractionMetrics => {
  let expectedDiscoveries = 0;
  let predictedDiscoveries = 0;
  let matchedDiscoveries = 0;
  let expectedEvidenceItems = 0;
  let matchedEvidenceItems = 0;
  let correctOrigins = 0;
  let expectedUrlIds = 0;
  let predictedUrlIds = 0;
  let correctUrlIds = 0;

  for (const row of rows) {
    expectedDiscoveries += row.expectedDiscoveries.length;
    predictedDiscoveries += row.predictedDiscoveries.length;
    expectedEvidenceItems +=
      row.expectedDiscoveries.length +
      (row.expectedExpertNoteOrigin === null ? 0 : 1);
    expectedUrlIds += row.expectedDiscoveries.reduce(
      (total, discovery) => total + discovery.urlCandidateIds.length,
      0,
    );

    const { matches, unmatchedPredicted } = matchDiscoveries(
      row.expectedDiscoveries,
      row.predictedDiscoveries,
    );
    matchedDiscoveries += matches.length;
    matchedEvidenceItems += matches.length;
    for (const match of matches) {
      if (match.expected.evidenceOrigin === match.predicted.evidenceOrigin) {
        correctOrigins += 1;
      }
      const expectedIds = new Set(match.expected.urlCandidateIds);
      predictedUrlIds += match.predicted.urlCandidateIds.length;
      correctUrlIds += match.predicted.urlCandidateIds.filter((id) =>
        expectedIds.has(id),
      ).length;
    }
    predictedUrlIds += unmatchedPredicted.reduce(
      (total, discovery) => total + discovery.urlCandidateIds.length,
      0,
    );

    if (
      row.expectedExpertNoteOrigin !== null &&
      row.predictedExpertNoteOrigin !== null
    ) {
      matchedEvidenceItems += 1;
      if (row.expectedExpertNoteOrigin === row.predictedExpertNoteOrigin) {
        correctOrigins += 1;
      }
    }
  }

  return {
    expectedDiscoveries,
    predictedDiscoveries,
    matchedDiscoveries,
    discoveryExtractionPrecision:
      predictedDiscoveries === 0
        ? expectedDiscoveries === 0
          ? 1
          : 0
        : matchedDiscoveries / predictedDiscoveries,
    discoveryExtractionRecall:
      expectedDiscoveries === 0 ? 1 : matchedDiscoveries / expectedDiscoveries,
    matchedEvidenceItems,
    expectedEvidenceItems,
    goldEvidenceOriginAgreement:
      matchedEvidenceItems === 0
        ? expectedEvidenceItems === 0
          ? 1
          : 0
        : correctOrigins / matchedEvidenceItems,
    goldEvidenceOriginCoverage:
      expectedEvidenceItems === 0
        ? 1
        : matchedEvidenceItems / expectedEvidenceItems,
    predictedUrlIds,
    expectedUrlIds,
    correctUrlIds,
    urlGroundingPrecision:
      predictedUrlIds === 0 ? 1 : correctUrlIds / predictedUrlIds,
    urlGroundingRecall:
      expectedUrlIds === 0 ? 1 : correctUrlIds / expectedUrlIds,
  };
};
