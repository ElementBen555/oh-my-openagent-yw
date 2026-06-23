import type { ExtendedModelResolutionInput, ModelResolutionInput } from "@oh-my-opencode/model-core";
import {
	flattenToFallbackModelStrings,
	normalizeFallbackModels,
	resolveModel,
	resolveModelWithFallback as resolveModelWithFallbackFromCore,
} from "@oh-my-opencode/model-core";
import * as connectedProvidersCache from "./connected-providers-cache";

export { flattenToFallbackModelStrings, normalizeFallbackModels, resolveModel };

type CoreModelResolutionResult = ReturnType<typeof resolveModelWithFallbackFromCore>;
export type ModelResolutionResult = Exclude<CoreModelResolutionResult, undefined>;
export type ModelSource = ModelResolutionResult["source"];

export function resolveModelWithFallback(input: ExtendedModelResolutionInput): CoreModelResolutionResult {
	return resolveModelWithFallbackFromCore(input, connectedProvidersCache);
}

export type { ExtendedModelResolutionInput, ModelResolutionInput };
