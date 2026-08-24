export const APPLICATION_LAYER = "application" as const;
export {
  createStartIngestion,
  type StartIngestion,
} from "./ingest/start-ingestion.js";
export {
  createIngestSelectionRange,
  type IngestSelectionRange,
  type IngestSelectionRangeInput,
  type IngestSelectionRangeResult,
} from "./ingest/selection-range.js";
export {
  HnParentChainResolver,
  type ResolveHnCommentInput,
} from "./resolve-hn/parent-chain.js";
export {
  createResolveSelectedComment,
  type ResolveSelectedComment,
  type ResolveSelectedCommentInput,
} from "./resolve-hn/resolve-selected-comment.js";
export {
  normalizeHnCommentHtml,
  normalizePlainText,
} from "./normalize/hn-html.js";
export {
  reconstructMultipart,
  type ReconstructMultipartInput,
} from "./reconstruct/multipart.js";
