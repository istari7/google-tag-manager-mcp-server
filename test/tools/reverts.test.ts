// revert_workspace_entity: one confirm-gated tool for every revertable entity kind.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GetWorkspaceStatusResponse } from "../../src/gtm/generated";
import { UNPUBLISHED_CHANGES_NOTE } from "../../src/gtm/quirks";
import { folder, ga4EventTag, linkClickTrigger } from "../fixtures/gtm";
import { byMethod, callTool, describeCall, mockGtm, reply, WORKSPACE, WORKSPACE_ARGS, writes } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

const STATUS = `${WORKSPACE}/status`;

const status: GetWorkspaceStatusResponse = {
	workspaceChange: [
		{ changeStatus: "updated", tag: ga4EventTag },
		{ changeStatus: "added", trigger: linkClickTrigger },
		{ changeStatus: "deleted", folder },
		{ changeStatus: "added", builtInVariable: { type: "clickUrl", name: "Click URL" } },
	],
	mergeConflict: [{ entityInWorkspace: { changeStatus: "updated", tag: ga4EventTag } }],
};

describe("revert_workspace_entity: preview", () => {
	it.each([
		["tag", "12", "updated", "goes back to how it is in the latest version"],
		["trigger", "34", "added", "reverting deletes it"],
		["folder", "9", "deleted", "reverting brings it back"],
	])("%s %s (%s) reads the workspace status and changes nothing", async (kind, id, changeStatus, effect) => {
		const mock = mockGtm({ [STATUS]: reply(status) });
		const result = await callTool("revert_workspace_entity", { ...WORKSPACE_ARGS, kind, id });
		expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "GET", path: STATUS }]);
		const out = result.json<{ wouldRevert: Record<string, unknown>; effect: string; message: string }>();
		expect(out.wouldRevert).toMatchObject({ kind, id, changeStatus });
		expect(out.effect).toContain(effect);
		expect(out.message).toContain("call revert_workspace_entity again with confirm: true");
	});

	it("flags an entity that is in a merge conflict", async () => {
		mockGtm({ [STATUS]: reply(status) });
		const result = await callTool("revert_workspace_entity", { ...WORKSPACE_ARGS, kind: "tag", id: "12" });
		expect(result.json()).toMatchObject({ mergeConflict: true });
	});

	it("matches a built-in variable by its type", async () => {
		mockGtm({ [STATUS]: reply(status) });
		const result = await callTool("revert_workspace_entity", {
			...WORKSPACE_ARGS,
			kind: "builtInVariable",
			id: "clickUrl",
		});
		expect(result.json()).toMatchObject({
			wouldRevert: { kind: "builtInVariable", type: "clickUrl", changeStatus: "added" },
		});
	});

	it("refuses an entity the workspace did not change", async () => {
		mockGtm({ [STATUS]: reply(status) });
		const result = await callTool("revert_workspace_entity", { ...WORKSPACE_ARGS, kind: "variable", id: "56" });
		expect(result).toMatchObject({
			isError: true,
			text: "Workspace 7 has no change to variable 56, so there is nothing to revert.",
		});
	});

	it.each([
		["tag", "abc"],
		["tag", "12?x=1"],
		["builtInVariable", "notAType"],
		["builtInVariable", "12"],
	])("refuses kind %s with id %s before calling Google", async (kind, id) => {
		const mock = mockGtm();
		const result = await callTool("revert_workspace_entity", { ...WORKSPACE_ARGS, kind, id, confirm: true });
		expect(result.isError).toBe(true);
		expect(mock.calls).toHaveLength(0);
	});
});

describe("revert_workspace_entity: confirmed", () => {
	it.each([
		["tag", "tags", "tag"],
		["trigger", "triggers", "trigger"],
		["variable", "variables", "variable"],
		["folder", "folders", "folder"],
		["zone", "zones", "zone"],
		["template", "templates", "template"],
		["client", "clients", "client"],
		["transformation", "transformations", "transformation"],
	])("%s: POSTs {workspace}/%s/{id}:revert with ?fingerprint=", async (kind, segment, key) => {
		const path = `${WORKSPACE}/${segment}/77:revert`;
		const mock = mockGtm({ [path]: byMethod({ POST: reply({ [key]: { name: "Restored" } }) }) });
		const result = await callTool("revert_workspace_entity", {
			...WORKSPACE_ARGS,
			kind,
			id: "77",
			fingerprint: "123",
			confirm: true,
		});
		expect(mock.gtm().map(describeCall)).toMatchObject([
			{ method: "POST", path, query: { fingerprint: "123" }, body: undefined },
		]);
		expect(result.json()).toMatchObject({
			reverted: { kind, id: "77" },
			now: { kind, name: "Restored" },
			note: UNPUBLISHED_CHANGES_NOTE,
		});
	});

	it("says when the revert removed the entity (it was added in the workspace)", async () => {
		const path = `${WORKSPACE}/triggers/34:revert`;
		mockGtm({ [path]: reply({}) });
		const result = await callTool("revert_workspace_entity", {
			...WORKSPACE_ARGS,
			kind: "trigger",
			id: "34",
			confirm: true,
		});
		expect(result.json()).toMatchObject({ now: "gone: it is not in the latest version" });
	});

	it("builtInVariable: POSTs {workspace}/built_in_variables:revert?type=", async () => {
		const path = `${WORKSPACE}/built_in_variables:revert`;
		const mock = mockGtm({ [path]: byMethod({ POST: reply({ enabled: false }) }) });
		const result = await callTool("revert_workspace_entity", {
			...WORKSPACE_ARGS,
			kind: "builtInVariable",
			id: "clickUrl",
			confirm: true,
		});
		expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "POST", path, query: { type: "clickUrl" } }]);
		expect(result.json()).toMatchObject({ reverted: { kind: "builtInVariable", id: "clickUrl" }, enabled: false });
		expect(writes(mock.gtm())).toHaveLength(1);
	});
});
