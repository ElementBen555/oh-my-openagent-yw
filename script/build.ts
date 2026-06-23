#!/usr/bin/env bun
import { $ } from "bun";

interface BuildStep {
	name: string;
	cmd: () => ReturnType<typeof $>;
}

const steps: BuildStep[] = [
	{
		name: "build:git-bash-mcp",
		cmd: () => $`bun run --cwd packages/git-bash-mcp build`.nothrow(),
	},
	{
		name: "build:lsp-tools-mcp",
		cmd: () => $`npm --prefix packages/lsp-tools-mcp ci && npm --prefix packages/lsp-tools-mcp run build`.nothrow(),
	},
	{
		name: "build:lsp-daemon",
		cmd: () => $`npm --prefix packages/lsp-daemon ci && npm --prefix packages/lsp-daemon run build`.nothrow(),
	},
	{
		name: "build:codex-plugin",
		cmd: () =>
			$`npm --prefix packages/omo-codex/plugin ci && bun run --cwd packages/omo-codex/plugin build`.nothrow(),
	},
	{
		name: "bun build omo-opencode/src/index.ts",
		cmd: () =>
			$`bun build packages/omo-opencode/src/index.ts --outdir dist --target bun --format esm --external zod`.nothrow(),
	},
	{
		name: "bun build omo-opencode/src/tui.ts",
		cmd: () =>
			$`bun build packages/omo-opencode/src/tui.ts --outdir dist --target bun --format esm --external @opentui/core --external @opentui/keymap --external @opentui/solid`.nothrow(),
	},
	{
		name: "build:shared-skills-assets",
		cmd: () =>
			$`bun run build:materialize-frontend && rm -rf dist/skills && cp -R packages/shared-skills/skills dist/skills`.nothrow(),
	},
	{
		name: "build:node-require-shim",
		cmd: () => $`bun run script/patch-node-require-shim.ts`.nothrow(),
	},
	{
		name: "tsc --emitDeclarationOnly",
		cmd: () => $`tsc --emitDeclarationOnly`.nothrow(),
	},
	{
		name: "bun build omo-opencode/src/cli/index.ts",
		cmd: () =>
			$`bun build packages/omo-opencode/src/cli/index.ts --outdir dist/cli --target bun --format esm`.nothrow(),
	},
	{
		name: "build:cli-node",
		cmd: () => $`bun run script/build-cli-node.ts`.nothrow(),
	},
	{
		name: "build:codex-install",
		cmd: () => $`bun run script/build-codex-install.ts`.nothrow(),
	},
	{
		name: "build:schema",
		cmd: () => $`bun run script/build-schema.ts`.nothrow(),
	},
];

async function main(): Promise<void> {
	const total = steps.length;
	console.log(`Build — ${total} steps\n`);

	for (let i = 0; i < steps.length; i++) {
		const step = steps[i];
		const num = i + 1;
		console.log(`[${num}/${total}] ${step.name}...`);

		const result = await step.cmd();

		if (result.exitCode !== 0) {
			const stderrText = result.stderr.toString().trim();
			console.error(`\n❌ FAILED: ${step.name}`);
			if (stderrText) {
				console.error(stderrText);
			}
			process.exit(1);
		}
	}

	console.log("\n✅ Build complete");
}

main().catch((err: unknown) => {
	console.error("Unexpected build error:", err);
	process.exit(1);
});
