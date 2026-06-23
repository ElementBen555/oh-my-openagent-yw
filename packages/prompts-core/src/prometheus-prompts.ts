import defaultPrompt from "../prompts/prometheus/default.md";
import type { VariantTable } from "./types";

export const prometheusPromptVariants = {
	default: {
		kind: "bundled",
		content: defaultPrompt,
		filePath: "packages/prompts-core/prompts/prometheus/default.md",
	},
} satisfies VariantTable;
