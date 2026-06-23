import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { unsafeTestValue } from "../../../../test-support/unsafe-test-value";
import * as shared from "../shared";
import { createGithubMcpConfig } from "./github";

describe("createGithubMcpConfig", () => {
	let logSpy: ReturnType<typeof spyOn>;
	let originalEnv: string | undefined;

	beforeEach(() => {
		logSpy = spyOn(shared, unsafeTestValue("log")).mockImplementation(() => {});
		originalEnv = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
		delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
	});

	afterEach(() => {
		logSpy?.mockRestore();
		if (originalEnv !== undefined) {
			process.env.GITHUB_PERSONAL_ACCESS_TOKEN = originalEnv;
		} else {
			delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
		}
	});

	test("returns undefined when token is missing and logs a skip message", () => {
		// when
		const config = createGithubMcpConfig();

		// then
		expect(config).toBeUndefined();
		expect(logSpy).toHaveBeenCalledWith("[github-mcp] GITHUB_PERSONAL_ACCESS_TOKEN not set — skipping GitHub MCP");
	});

	test("returns local stdio MCP config when token is present", () => {
		// given
		process.env.GITHUB_PERSONAL_ACCESS_TOKEN = "ghp_test_token";

		// when
		const config = createGithubMcpConfig();

		// then
		expect(config).toBeDefined();
		expect(config?.type).toBe("local");
		expect(config?.command).toEqual(["npx", "-y", "@github/github-mcp-server"]);
		expect(config?.enabled).toBe(true);
		expect(config?.environment).toEqual({
			GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_test_token",
		});
	});
});
