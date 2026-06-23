import { parseGitStatusPorcelainLine } from "./parse-status-porcelain-line";
import type { GitFileStatus } from "./types";

export function parseGitStatusPorcelain(output: string): Map<string, GitFileStatus> {
	const map = new Map<string, GitFileStatus>();
	if (!output) return map;

	for (const line of output.split("\n")) {
		const parsed = parseGitStatusPorcelainLine(line);
		if (!parsed) continue;
		map.set(parsed.filePath, parsed.status);
	}

	return map;
}
