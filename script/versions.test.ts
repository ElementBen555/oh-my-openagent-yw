import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BUN_VERSION, MIN_OPENCODE_VERSION, NODE_MAJOR } from "./versions";

const REPO_ROOT = join(import.meta.dir, "..");

function readIfExists(path: string): string | null {
	return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

describe("version-constants-audit", () => {
	describe("bun-version in CI workflows", () => {
		const workflowsDir = join(REPO_ROOT, ".github", "workflows");
		const workflowFiles = [
			"ci.yml",
			"publish.yml",
			"publish-platform.yml",
			"sisyphus-agent.yml",
			"web-ci.yml",
			"web-deploy.yml",
			"refresh-model-capabilities.yml",
		];

		for (const wf of workflowFiles) {
			const path = join(workflowsDir, wf);
			if (!existsSync(path)) continue;

			const content = readFileSync(path, "utf-8");
			const bunLines = content.match(/bun-version:\s*"([^"]+)"/g);

			test(`${wf} pins Bun to ${BUN_VERSION}`, () => {
				if (!bunLines) return; // file may not use setup-bun

				for (const line of bunLines) {
					const version = line.match(/"([^"]+)"/)?.[1];
					expect(version, `${wf}: ${line.trim()} should be "${BUN_VERSION}"`).toBe(BUN_VERSION);
				}
			});
		}
	});

	describe("node-version in CI workflows", () => {
		const workflowsDir = join(REPO_ROOT, ".github", "workflows");
		const ciPath = join(workflowsDir, "ci.yml");

		test(`ci.yml uses Node ${NODE_MAJOR}`, () => {
			const content = readFileSync(ciPath, "utf-8");
			const nodeLines = content.match(/node-version:\s*(\d+)/g);
			if (!nodeLines) return;

			for (const line of nodeLines) {
				const version = parseInt(line.match(/(\d+)/)?.[1] ?? "0", 10);
				expect(version, `${line.trim()} should be ${NODE_MAJOR}`).toBe(NODE_MAJOR);
			}
		});
	});

	describe("Dockerfile pins", () => {
		const dockerfilePath = join(REPO_ROOT, ".devcontainer", "Dockerfile");
		const content = readIfExists(dockerfilePath);

		test(`Dockerfile FROM uses Node ${NODE_MAJOR}`, () => {
			if (!content) return;
			const fromLine = content.match(/FROM\s+\S+/);
			expect(fromLine?.[0], `FROM should reference node ${NODE_MAJOR}`).toContain(String(NODE_MAJOR));
		});

		test(`Dockerfile installs Bun ${BUN_VERSION}`, () => {
			if (!content) return;
			expect(content, `Dockerfile should install Bun ${BUN_VERSION}`).toContain(BUN_VERSION);
		});
	});

	describe("setup.sh pins", () => {
		const setupPath = join(REPO_ROOT, "script", "agent", "setup.sh");
		const content = readIfExists(setupPath);

		test(`setup.sh expects Bun ${BUN_VERSION}`, () => {
			if (!content) return;
			expect(content, "setup.sh expected_bun should match").toContain(`expected_bun="${BUN_VERSION}"`);
		});

		test(`setup.sh expects Node major ${NODE_MAJOR}`, () => {
			if (!content) return;
			expect(content, "setup.sh expected_node_major should match").toContain(`expected_node_major="${NODE_MAJOR}"`);
		});
	});

	describe("MIN_OPENCODE_VERSION uniqueness", () => {
		test("postinstall.mjs and constants.ts agree", () => {
			const postinstall = readIfExists(join(REPO_ROOT, "postinstall.mjs"));
			const constants = readIfExists(
				join(REPO_ROOT, "packages", "omo-opencode", "src", "cli", "doctor", "framework", "constants.ts"),
			);

			if (postinstall && constants) {
				const pm = postinstall.match(/MIN_OPENCODE_VERSION\s*=\s*"([^"]+)"/);
				const ct = constants.match(/MIN_OPENCODE_VERSION\s*=\s*"([^"]+)"/);
				if (pm && ct) {
					expect(pm[1], "Both files should agree").toBe(ct[1]);
				}
			}
		});
	});
});
