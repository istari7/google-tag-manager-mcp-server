// get_workspace, update_workspace (workspaces group), and the workspace-admin group:
// sync_workspace, resolve_workspace_conflict, bulk_update_workspace (all confirm-gated).

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GetWorkspaceStatusResponse, Workspace } from "../../src/gtm/generated";
import { UNPUBLISHED_CHANGES_NOTE } from "../../src/gtm/quirks";
import { ga4EventTag, linkClickTrigger } from "../fixtures/gtm";
import {
	byMethod,
	CONTAINER,
	callTool,
	describeCall,
	empty,
	mockGtm,
	reply,
	WORKSPACE,
	WORKSPACE_ARGS,
	writes,
} from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

const STATUS = `${WORKSPACE}/status`;
const LATEST = `${CONTAINER}/version_headers:latest`;

const stored: Workspace = {
	workspaceId: "7",
	name: "Default Workspace",
	description: "Main",
	fingerprint: "100",
	path: WORKSPACE,
	accountId: "1234567890",
	containerId: "201",
	tagManagerUrl: "https://x",
};

describe("get_workspace", () => {
	it("GETs the workspace and returns its name, description and fingerprint", async () => {
		const mock = mockGtm({ [WORKSPACE]: reply(stored) });
		const result = await callTool("get_workspace", WORKSPACE_ARGS);
		expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "GET", path: WORKSPACE, query: {} }]);
		expect(result.json()).toEqual({
			workspaceId: "7",
			name: "Default Workspace",
			description: "Main",
			fingerprint: "100",
		});
	});

	it("rejects a non-numeric workspaceId before calling Google", async () => {
		const mock = mockGtm();
		const result = await callTool("get_workspace", { ...WORKSPACE_ARGS, workspaceId: "7/../8" });
		expect(result.isError).toBe(true);
		expect(mock.calls).toHaveLength(0);
	});
});

describe("update_workspace", () => {
	it("Q1/Q2: GETs, then PUTs the whole merged workspace with ?fingerprint=", async () => {
		const mock = mockGtm({
			[WORKSPACE]: byMethod({
				GET: reply(stored),
				PUT: reply({ ...stored, name: "Checkout", fingerprint: "101" }),
			}),
		});
		const result = await callTool("update_workspace", { ...WORKSPACE_ARGS, name: "Checkout", fingerprint: "100" });
		const calls = mock.gtm().map(describeCall);
		expect(calls).toMatchObject([
			{ method: "GET", path: WORKSPACE },
			{ method: "PUT", path: WORKSPACE, query: { fingerprint: "100" } },
		]);
		// The description is kept; the fingerprint is not in the body.
		expect(calls[1]?.body).toEqual({
			workspaceId: "7",
			name: "Checkout",
			description: "Main",
			path: WORKSPACE,
			accountId: "1234567890",
			containerId: "201",
			tagManagerUrl: "https://x",
		});
		expect(result.json()).toMatchObject({
			workspace: { workspaceId: "7", name: "Checkout", description: "Main", fingerprint: "101" },
		});
	});

	it('"" clears the description', async () => {
		const mock = mockGtm({ [WORKSPACE]: byMethod({ GET: reply(stored), PUT: reply(stored) }) });
		await callTool("update_workspace", { ...WORKSPACE_ARGS, description: "" });
		expect(describeCall(mock.gtm()[1]).body).toMatchObject({ name: "Default Workspace", description: "" });
	});

	it("Q2: a stale fingerprint fails with a conflict and sends no PUT", async () => {
		const mock = mockGtm({ [WORKSPACE]: byMethod({ GET: reply(stored) }) });
		const result = await callTool("update_workspace", { ...WORKSPACE_ARGS, name: "X", fingerprint: "99" });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("Changed by someone else");
		expect(writes(mock.gtm())).toHaveLength(0);
	});

	it("refuses an empty patch before calling Google", async () => {
		const mock = mockGtm();
		const result = await callTool("update_workspace", WORKSPACE_ARGS);
		expect(result).toMatchObject({ isError: true, text: "Nothing to change: pass name and/or description." });
		expect(mock.calls).toHaveLength(0);
	});
});

describe("sync_workspace", () => {
	const SYNC = `${WORKSPACE}:sync`;
	const status: GetWorkspaceStatusResponse = { workspaceChange: [{ changeStatus: "added", tag: ga4EventTag }] };

	it.each([{}, { confirm: false }])("without confirm: true (%o) only reads and previews", async (extra) => {
		const mock = mockGtm({
			[STATUS]: reply(status),
			[LATEST]: reply({ containerVersionId: "42", name: "Latest" }),
		});
		const result = await callTool("sync_workspace", { ...WORKSPACE_ARGS, ...extra });
		expect(writes(mock.gtm())).toHaveLength(0);
		expect(result.json()).toMatchObject({
			preview: true,
			latestVersion: { containerVersionId: "42", name: "Latest" },
			pendingChanges: 1,
			conflicts: 0,
		});
		expect(result.json<{ message: string }>().message).toContain("call sync_workspace again with confirm: true");
	});

	it("with confirm: true POSTs {workspace}:sync and lists the conflicts with their fingerprints", async () => {
		const mock = mockGtm({
			[SYNC]: byMethod({
				POST: reply({
					syncStatus: { mergeConflict: true },
					mergeConflict: [{ entityInWorkspace: { changeStatus: "updated", trigger: linkClickTrigger } }],
				}),
			}),
		});
		const result = await callTool("sync_workspace", { ...WORKSPACE_ARGS, confirm: true });
		expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "POST", path: SYNC, query: {}, body: undefined }]);
		const out = result.json<{ conflicts: unknown; note: string }>();
		expect(out.conflicts).toEqual([
			{ kind: "trigger", id: "34", name: "Link - Outbound", fingerprint: linkClickTrigger.fingerprint },
		]);
		expect(out.note).toContain("resolve each");
	});

	it("with confirm: true and no conflicts says so", async () => {
		mockGtm({ [SYNC]: reply({}) });
		const result = await callTool("sync_workspace", { ...WORKSPACE_ARGS, confirm: true });
		expect(result.json()).toMatchObject({ synced: true });
		expect(result.json<{ note: string }>().note).toContain("no conflicts");
	});

	it("reports a sync error", async () => {
		mockGtm({ [SYNC]: reply({ syncStatus: { syncError: true } }) });
		const result = await callTool("sync_workspace", { ...WORKSPACE_ARGS, confirm: true });
		expect(result).toMatchObject({ isError: true, text: "GTM could not sync the workspace. Retry." });
	});
});

describe("resolve_workspace_conflict", () => {
	const RESOLVE = `${WORKSPACE}:resolve_conflict`;
	const resolved = { ...linkClickTrigger, name: "Link - Outbound (merged)" };
	const conflictStatus: GetWorkspaceStatusResponse = {
		mergeConflict: [
			{
				entityInWorkspace: { changeStatus: "updated", trigger: { ...linkClickTrigger, fingerprint: "555" } },
				entityInBaseVersion: { trigger: { ...linkClickTrigger, name: "Link - Outbound v2" } },
			},
		],
	};

	it("without confirm: true previews both sides of the conflict and its fingerprint, with no write", async () => {
		const mock = mockGtm({ [STATUS]: reply(conflictStatus) });
		const result = await callTool("resolve_workspace_conflict", { ...WORKSPACE_ARGS, trigger: resolved });
		expect(writes(mock.gtm())).toHaveLength(0);
		expect(result.json()).toMatchObject({
			preview: true,
			conflict: {
				inWorkspace: { kind: "trigger", id: "34", name: "Link - Outbound", changeStatus: "updated" },
				inLatestVersion: { kind: "trigger", id: "34", name: "Link - Outbound v2" },
				fingerprint: "555",
			},
		});
	});

	it("with confirm: true POSTs {workspace}:resolve_conflict?fingerprint= with the resolved entity", async () => {
		const mock = mockGtm({ [RESOLVE]: byMethod({ POST: empty }) });
		const result = await callTool("resolve_workspace_conflict", {
			...WORKSPACE_ARGS,
			trigger: resolved,
			changeStatus: "updated",
			fingerprint: "555",
			confirm: true,
		});
		expect(mock.gtm().map(describeCall)).toEqual([
			expect.objectContaining({
				method: "POST",
				path: RESOLVE,
				query: { fingerprint: "555" },
				body: { trigger: resolved, changeStatus: "updated" },
			}),
		]);
		expect(result.json()).toEqual({ resolved: { kind: "trigger", id: "34" }, note: UNPUBLISHED_CHANGES_NOTE });
	});

	it("with confirm: true and no fingerprint, takes it from the conflict", async () => {
		const mock = mockGtm({ [STATUS]: reply(conflictStatus), [RESOLVE]: byMethod({ POST: empty }) });
		await callTool("resolve_workspace_conflict", { ...WORKSPACE_ARGS, trigger: resolved, confirm: true });
		expect(describeCall(mock.gtm()[1])).toMatchObject({ path: RESOLVE, query: { fingerprint: "555" } });
	});

	it("refuses when there is no conflict on that entity", async () => {
		const mock = mockGtm({ [STATUS]: reply({}) });
		const result = await callTool("resolve_workspace_conflict", {
			...WORKSPACE_ARGS,
			trigger: resolved,
			confirm: true,
		});
		expect(result).toMatchObject({ isError: true, text: "Workspace 7 has no merge conflict on trigger 34." });
		expect(writes(mock.gtm())).toHaveLength(0);
	});

	it("refuses zero or two entities, and an entity without a numeric ID, before calling Google", async () => {
		const mock = mockGtm();
		for (const args of [{}, { trigger: resolved, tag: ga4EventTag }, { tag: { name: "no id" } }]) {
			const result = await callTool("resolve_workspace_conflict", { ...WORKSPACE_ARGS, ...args, confirm: true });
			expect(result.isError).toBe(true);
			expect(result.text).toContain("Nothing was resolved");
		}
		expect(mock.calls).toHaveLength(0);
	});
});

describe("bulk_update_workspace", () => {
	const BULK = `${WORKSPACE}/bulk_update`;
	const changes = [
		{ changeStatus: "added", folder: { folderId: "new_1", name: "Checkout" } },
		{ changeStatus: "added", tag: { tagId: "new_2", name: "HTML - x", type: "html", parentFolderId: "new_1" } },
		{ changeStatus: "updated", trigger: linkClickTrigger },
		{ changeStatus: "deleted", tag: { tagId: "12" } },
	];

	it("without confirm: true lists the changes and calls nothing", async () => {
		const mock = mockGtm();
		const result = await callTool("bulk_update_workspace", { ...WORKSPACE_ARGS, changes });
		expect(mock.calls).toHaveLength(0);
		expect(result.json()).toMatchObject({
			preview: true,
			wouldApply: [
				{ changeStatus: "added", kind: "folder", id: "new_1", name: "Checkout" },
				{ changeStatus: "added", kind: "tag", id: "new_2", name: "HTML - x" },
				{ changeStatus: "updated", kind: "trigger", id: "34", name: "Link - Outbound" },
				{ changeStatus: "deleted", kind: "tag", id: "12" },
			],
		});
	});

	it("with confirm: true POSTs {workspace}/bulk_update with the changes as given", async () => {
		const mock = mockGtm({
			[BULK]: byMethod({
				POST: reply({ changes: [{ changeStatus: "added", folder: { folderId: "20", name: "Checkout" } }] }),
			}),
		});
		const result = await callTool("bulk_update_workspace", { ...WORKSPACE_ARGS, changes, confirm: true });
		expect(mock.gtm().map(describeCall)).toEqual([
			expect.objectContaining({ method: "POST", path: BULK, query: {}, body: { changes } }),
		]);
		expect(result.json()).toEqual({
			applied: 4,
			changed: [{ kind: "folder", id: "20", name: "Checkout", changeStatus: "added" }],
			note: UNPUBLISHED_CHANGES_NOTE,
		});
	});

	it.each([
		[{ changeStatus: "added", tag: { tagId: "12", name: "x" } }, 'an added tag needs an ID like "new_1"'],
		[{ changeStatus: "updated", tag: { tagId: "new_1" } }, "the tag needs its numeric ID"],
		[{ changeStatus: "deleted" }, "exactly one of tag, trigger, variable or folder"],
	])("refuses %o before calling Google, even with confirm: true", async (change, text) => {
		const mock = mockGtm();
		const result = await callTool("bulk_update_workspace", { ...WORKSPACE_ARGS, changes: [change], confirm: true });
		expect(result.isError).toBe(true);
		expect(result.text).toContain(text);
		expect(mock.calls).toHaveLength(0);
	});

	it("refuses an empty change list", async () => {
		const mock = mockGtm();
		expect((await callTool("bulk_update_workspace", { ...WORKSPACE_ARGS, changes: [] })).isError).toBe(true);
		expect(mock.calls).toHaveLength(0);
	});
});
