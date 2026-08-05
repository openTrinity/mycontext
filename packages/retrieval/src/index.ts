export { tokenize, toIndexSegment, toQueryTokens, toQueryTokenTiers } from "./bigram.js"

export { toMatchExpr, quoteToken, hasSpecialChars } from "./match-expr.js"

export {
  quantizeInt8,
  dequantizeInt8,
  cosineInt8,
  encodeFloat32,
  decodeFloat32,
} from "./quantize.js"
export type { QuantizedVector } from "./quantize.js"

export { knnSearch, InlineKnnBackend } from "./knn.js"
export type { KnnCandidate, KnnHit, KnnBackend } from "./knn.js"

export { recallMessages, renderRecallForPrompt, DEFAULT_RECALL_LIMIT } from "./recall.js"
export type { RecallHit, RecallResult, RecallOptions } from "./recall.js"

export { fuseRrf, buildRecallDebug } from "./fuse.js"
export type { RankedList, FusedHit, RecallDebug } from "./fuse.js"
