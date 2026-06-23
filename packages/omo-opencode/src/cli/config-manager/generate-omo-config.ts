import { generateModelConfig } from "../model-fallback";
import type { InstallConfig } from "../types";

export function generateOmoConfig(installConfig: InstallConfig): Record<string, unknown> {
	return generateModelConfig(installConfig);
}
