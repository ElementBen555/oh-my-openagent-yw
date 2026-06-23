/**
 * Canonical version constants — single source of truth.
 *
 * When updating a version here, also update:
 *   - .github/workflows/ci.yml (setup-bun bun-version, setup-node node-version)
 *   - .github/workflows/publish.yml
 *   - .github/workflows/publish-platform.yml
 *   - .github/workflows/sisyphus-agent.yml
 *   - .github/workflows/web-ci.yml, web-deploy.yml, refresh-model-capabilities.yml
 *   - .devcontainer/Dockerfile (FROM line, Bun install)
 *   - script/agent/setup.sh (expected_bun, expected_node_major)
 *
 * Run `bun test script/versions.test.ts` to detect drift.
 */
export const BUN_VERSION = "1.3.12" as const;
export const NODE_MAJOR = 24 as const;
export const MIN_OPENCODE_VERSION = "1.4.0" as const;

/** npm package names recognized as this plugin */
export const OPENCODE_PLUGIN_PACKAGES = ["oh-my-opencode", "oh-my-openagent"] as const;
