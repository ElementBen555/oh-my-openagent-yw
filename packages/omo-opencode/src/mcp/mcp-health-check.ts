import { log } from "../shared/logger";

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

export type RemoteMcpProbeResult = {
	readonly name: string;
	readonly url: string;
	readonly reachable: boolean;
	readonly status?: number;
	readonly error?: string;
};

export async function probeRemoteMcp(
	name: string,
	url: string,
	headers?: Record<string, string>,
	timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<RemoteMcpProbeResult> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(url, {
			method: "HEAD",
			headers,
			signal: controller.signal,
		});

		return {
			name,
			url,
			reachable: response.ok || response.status === 405,
			status: response.status,
		};
	} catch (error) {
		return {
			name,
			url,
			reachable: false,
			error: error instanceof Error ? error.message : "unknown error",
		};
	} finally {
		clearTimeout(timeoutId);
	}
}

export async function probeBuiltinRemoteMcps(
	mcps: Record<string, Record<string, unknown>>,
): Promise<Record<string, Record<string, unknown>>> {
	const probes: Promise<RemoteMcpProbeResult>[] = [];

	for (const [name, config] of Object.entries(mcps)) {
		if (!config || typeof config !== "object") {
			continue;
		}

		if (config.type !== "remote" || typeof config.url !== "string" || config.url.trim().length === 0) {
			continue;
		}

		const headers =
			typeof config.headers === "object" && config.headers !== null && !Array.isArray(config.headers)
				? (config.headers as Record<string, string>)
				: undefined;

		probes.push(probeRemoteMcp(name, config.url, headers));
	}

	const results = await Promise.all(probes);
	const out = { ...mcps };

	for (const result of results) {
		if (!result.reachable) {
			log(
				`[mcp-health-check] MCP "${result.name}" at ${result.url} is unreachable` +
					(result.error ? ` (${result.error})` : result.status ? ` (HTTP ${result.status})` : "") +
					" — disabling to allow offline operation",
			);
			out[result.name] = { ...out[result.name], enabled: false };
		}
	}

	return out;
}
