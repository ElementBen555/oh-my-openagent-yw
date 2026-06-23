import type { ErrorInfo } from "@oh-my-opencode/model-core";
import {
	getNextFallback,
	hasMoreFallbacks,
	isRetryableModelError,
	selectFallbackProviderWithCache,
	shouldRetryError,
} from "@oh-my-opencode/model-core";
import * as connectedProvidersCache from "./connected-providers-cache";

export type { ErrorInfo };
export { getNextFallback, hasMoreFallbacks, isRetryableModelError, selectFallbackProviderWithCache, shouldRetryError };

export function selectFallbackProvider(providers: string[], preferredProviderID?: string): string {
	return selectFallbackProviderWithCache(providers, connectedProvidersCache, preferredProviderID);
}
