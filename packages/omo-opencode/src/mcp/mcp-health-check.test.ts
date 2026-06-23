import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { probeBuiltinRemoteMcps, probeRemoteMcp } from "./mcp-health-check";

describe("probeRemoteMcp", () => {
	let fetchSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		fetchSpy = spyOn(globalThis, "fetch");
	});

	afterEach(() => {
		fetchSpy?.mockRestore();
	});

	test("returns reachable:true for a responding endpoint", async () => {
		// given
		fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));

		// when
		const result = await probeRemoteMcp("test", "https://example.com/mcp");

		// then
		expect(result.reachable).toBe(true);
		expect(result.status).toBe(200);
		expect(fetchSpy).toHaveBeenCalledWith("https://example.com/mcp", expect.objectContaining({ method: "HEAD" }));
	});

	test("sends configured headers with the probe", async () => {
		// given
		fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));
		const headers = { Authorization: "Bearer token" };

		// when
		const result = await probeRemoteMcp("test", "https://example.com/mcp", headers);

		// then
		expect(result.reachable).toBe(true);
		expect(fetchSpy).toHaveBeenCalledWith(
			"https://example.com/mcp",
			expect.objectContaining({ method: "HEAD", headers }),
		);
	});

	test("treats 405 Method Not Allowed as reachable", async () => {
		// given
		fetchSpy.mockResolvedValue(new Response(null, { status: 405 }));

		// when
		const result = await probeRemoteMcp("test", "https://example.com/mcp");

		// then
		expect(result.reachable).toBe(true);
		expect(result.status).toBe(405);
	});

	test("returns reachable:false for a failing endpoint", async () => {
		// given
		fetchSpy.mockResolvedValue(new Response(null, { status: 503 }));

		// when
		const result = await probeRemoteMcp("test", "https://example.com/mcp");

		// then
		expect(result.reachable).toBe(false);
		expect(result.status).toBe(503);
	});

	test("returns reachable:false for a network error", async () => {
		// given
		fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));

		// when
		const result = await probeRemoteMcp("test", "https://example.com/mcp");

		// then
		expect(result.reachable).toBe(false);
		expect(result.error).toBe("ECONNREFUSED");
	});

	test("aborts after the configured timeout", async () => {
		// given
		fetchSpy.mockImplementation((_url, init) => {
			return new Promise((_resolve, reject) => {
				const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
				if (signal?.aborted) {
					reject(new Error("Aborted"));
					return;
				}
				const onAbort = (): void => reject(new Error("Aborted"));
				signal?.addEventListener("abort", onAbort);
			});
		});

		// when
		const result = await probeRemoteMcp("test", "https://example.com/mcp", undefined, 50);

		// then
		expect(result.reachable).toBe(false);
		expect(result.error).toContain("Aborted");
	});
});

describe("probeBuiltinRemoteMcps", () => {
	let fetchSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		fetchSpy = spyOn(globalThis, "fetch");
	});

	afterEach(() => {
		fetchSpy?.mockRestore();
	});

	test("disables unreachable remote MCPs and keeps local MCPs intact", async () => {
		// given
		fetchSpy.mockRejectedValue(new Error("offline"));
		const mcps: Record<string, Record<string, unknown>> = {
			websearch: { type: "remote", url: "https://mcp.exa.ai/mcp", enabled: true },
			lsp: { type: "local", command: ["node", "cli.js"], enabled: true },
		};

		// when
		const result = await probeBuiltinRemoteMcps(mcps);

		// then
		expect(result.websearch.enabled).toBe(false);
		expect(result.lsp.enabled).toBe(true);
	});

	test("passes headers through to the probe", async () => {
		// given
		fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));
		const mcps: Record<string, Record<string, unknown>> = {
			context7: {
				type: "remote",
				url: "https://mcp.context7.com/mcp",
				enabled: true,
				headers: { Authorization: "Bearer abc123" },
			},
		};

		// when
		const result = await probeBuiltinRemoteMcps(mcps);

		// then
		expect(result.context7.enabled).toBe(true);
		expect(fetchSpy).toHaveBeenCalledWith(
			"https://mcp.context7.com/mcp",
			expect.objectContaining({
				method: "HEAD",
				headers: { Authorization: "Bearer abc123" },
			}),
		);
	});

	test("ignores array-shaped headers (defensive)", async () => {
		// given
		fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));
		const mcps: Record<string, Record<string, unknown>> = {
			bad: {
				type: "remote",
				url: "https://example.com/mcp",
				enabled: true,
				headers: ["Authorization", "Bearer malformed"],
			},
		};

		// when
		const result = await probeBuiltinRemoteMcps(mcps);

		// then
		expect(result.bad.enabled).toBe(true);
		expect(fetchSpy).toHaveBeenCalledWith(
			"https://example.com/mcp",
			expect.objectContaining({
				method: "HEAD",
				headers: undefined,
			}),
		);
	});

	test("skips entries with an empty url", async () => {
		// given
		fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));
		const mcps: Record<string, Record<string, unknown>> = {
			empty: { type: "remote", url: "", enabled: true },
			valid: { type: "remote", url: "https://example.com/mcp", enabled: true },
		};

		// when
		const result = await probeBuiltinRemoteMcps(mcps);

		// then
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(result.empty.enabled).toBe(true);
		expect(result.valid.enabled).toBe(true);
	});

	test("skips entries with null or undefined config", async () => {
		// given
		fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));
		const mcps = {
			nullEntry: null,
			undefinedEntry: undefined,
			valid: { type: "remote", url: "https://example.com/mcp", enabled: true } as Record<string, unknown>,
		} as unknown as Record<string, Record<string, unknown>>;

		// when
		const result = await probeBuiltinRemoteMcps(mcps);

		// then
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(result.nullEntry).toBeNull();
		expect(result.undefinedEntry).toBeUndefined();
		expect(result.valid.enabled).toBe(true);
	});

	test("keeps reachable remote MCPs enabled", async () => {
		// given
		fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));
		const mcps: Record<string, Record<string, unknown>> = {
			context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
		};

		// when
		const result = await probeBuiltinRemoteMcps(mcps);

		// then
		expect(result.context7.enabled).toBe(true);
	});
});
