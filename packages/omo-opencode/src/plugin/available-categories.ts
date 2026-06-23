import type { AvailableCategory } from "../agents/dynamic-agent-prompt-builder";
import type { OhMyOpenCodeConfig } from "../config";
import { mergeCategories } from "../shared/merge-categories";
import { CATEGORY_DESCRIPTIONS } from "../tools/delegate-task/constants";

export function createAvailableCategories(pluginConfig: OhMyOpenCodeConfig): AvailableCategory[] {
	const categories = mergeCategories(pluginConfig.categories);

	return Object.entries(categories).map(([name, categoryConfig]) => {
		const model = typeof categoryConfig.model === "string" ? categoryConfig.model : undefined;

		return {
			name,
			description: pluginConfig.categories?.[name]?.description ?? CATEGORY_DESCRIPTIONS[name] ?? "General tasks",
			model,
		};
	});
}
