import { describe, expect, test } from "bun:test";
import { ackMessages as coreAckMessages } from "@oh-my-opencode/team-core/team-mailbox/ack";
import { ackMessages } from "./ack";

describe("ackMessages adapter shim", () => {
	test("#given omo-opencode shim #when imported #then it re-exports team-core implementation", () => {
		expect(ackMessages.name).toBe(coreAckMessages.name);
		expect(ackMessages.length).toBe(coreAckMessages.length);
	});
});
