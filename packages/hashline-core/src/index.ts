/**
 * Hashline core public API.
 *
 * Hash dependency choice: Option 2.
 * This package embeds a runtime-aware xxHash32 implementation (`xxhash32.ts`)
 * that prefers the host runtime's native xxHash32 binding when available and
 * falls back to a pure-JS implementation otherwise. No package-level dependency
 * on any specific runtime; the binding is detected via globalThis at call time.
 */

export {
	autocorrectReplacementLines,
	maybeExpandSingleLineMerge,
	restoreIndentForPairedReplacement,
	restoreOldWrappedLines,
	stripMergeOperatorChars,
	stripTrailingContinuationTokens,
} from "./autocorrect-replacement-lines";
export { HASHLINE_DICT, HASHLINE_OUTPUT_PATTERN, HASHLINE_REF_PATTERN, NIBBLE_STR } from "./constants";
export { countLineDiffs, generateUnifiedDiff, toHashlineContent } from "./diff-utils";
export { dedupeEdits } from "./edit-deduplication";
export {
	applyAppend,
	applyInsertAfter,
	applyInsertBefore,
	applyPrepend,
	applyReplaceLines,
	applySetLine,
} from "./edit-operation-primitives";
export type { HashlineApplyReport } from "./edit-operations";
export { applyHashlineEdits, applyHashlineEditsWithReport } from "./edit-operations";
export { collectLineRefs, detectOverlappingRanges, getEditLineNumber } from "./edit-ordering";
export {
	restoreLeadingIndent,
	stripInsertAnchorEcho,
	stripInsertBeforeEcho,
	stripInsertBoundaryEcho,
	stripLinePrefixes,
	stripRangeBoundaryEcho,
	toNewLines,
} from "./edit-text-normalization";
export type { FileTextEnvelope } from "./file-text-canonicalization";
export { canonicalizeFileText, restoreFileText } from "./file-text-canonicalization";
export type { HashlineStreamOptions } from "./hash-computation";
export {
	computeLegacyLineHash,
	computeLineHash,
	formatHashLine,
	formatHashLines,
	streamHashLinesFromLines,
	streamHashLinesFromUtf8,
} from "./hash-computation";
export type { HashlineChunkFormatter } from "./hashline-chunk-formatter";
export { createHashlineChunkFormatter } from "./hashline-chunk-formatter";
export { generateHashlineDiff } from "./hashline-edit-diff";
export type { RawHashlineEdit } from "./normalize-edits";
export { normalizeHashlineEdits } from "./normalize-edits";
export type { AppendEdit, HashlineEdit, PrependEdit, ReplaceEdit } from "./types";
export type { LineRef } from "./validation";
export { HashlineMismatchError, normalizeLineRef, parseLineRef, validateLineRef, validateLineRefs } from "./validation";
