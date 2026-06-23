import { describe, expect, test } from "bun:test";
import {
	createWorktree as coreCreateWorktree,
	validateWorktreeSpec as coreValidateWorktreeSpec,
} from "@oh-my-opencode/team-core/team-worktree/manager";
import { createWorktree, validateWorktreeSpec } from "./manager";

describe("team-worktree manager adapter shim", () => {
	test("#given omo-opencode shim #when imported #then it re-exports team-core implementation", () => {
		expect(createWorktree).toBe(coreCreateWorktree);
		expect(validateWorktreeSpec).toBe(coreValidateWorktreeSpec);
	});
});
