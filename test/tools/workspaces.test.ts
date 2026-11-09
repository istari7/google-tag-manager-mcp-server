// list_workspaces, get_workspace_status (Q9), create_workspace, quick_preview_workspace.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GetWorkspaceStatusResponse } from "../../src/gtm/generated";
import { WORKSPACE_NOT_LIVE_NOTE } from "../../src/tools/summaries";
import { errors, folder, ga4EventTag, linkClickTrigger } from "../fixtures/gtm";
import {
	CONTAINER,
	CONTAINER_ARGS,
	callTool,
	describeCall,
	mockGtm,
	pages,
	reply,
	WORKSPACE,
	WORKSPACE_ARGS,
	writes,
} from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("list_workspaces", () => {
	it("GETs the container's workspaces across pages", async () => {
		const mock = mockGtm({
			[`${CONTAINER}/workspaces`]: pages("workspace", [
				[{ workspaceId: "7", name: "Default Workspace", description: "", fingerprint: "1", path: WORKSPACE }],
				[{ workspaceId: "8", name: "Add GA4 ecommerce", description: "Checkout events", tagManagerUrl: "https://x" }],
			]),
		});
		const result = await callTool("list_workspaces", CONTAINER_ARGS);
		expect(result.json()).toEqual({
			workspaces: [
				{ workspaceId: "7", name: "Default Workspace", description: "" },
				{ workspaceId: "8", name: "Add GA4 ecommerce", description: "Checkout events" },
			],
		});
		expect(mock.gtm().map(describeCall)).toMatchObject([
			{ method: "GET", path: `${CONTAINER}/workspaces`, query: {} },
			{ method: "GET", path: `${CONTAINER}/workspaces`, query: { pageToken: "p2" } },
		]);
	});
});

describe("get_workspace_status", () => {
	it("GETs {workspace}/status and lists changes and conflicts by kind, ID and name", async () => {
		const status: GetWorkspaceStatusResponse = {
			workspaceChange: [
				{ changeStatus: "added", tag: ga4EventTag },
				{ changeStatus: "updated", trigger: linkClickTrigger },
				{ changeStatus: "deleted", folder },
				{ changeStatus: "added", builtInVariable: { type: "clickUrl", name: "Click URL" } },
			],
			mergeConflict: [{ entityInWorkspace: { changeStatus: "updated", tag: ga4EventTag } }],
		};
		const mock = mockGtm({ [`${WORKSPACE}/status`]: reply(status) });
		const result = await callTool("get_workspace_status", WORKSPACE_ARGS);
		expect(describeCall(mock.gtm()[0])).toMatchObject({ method: "GET", path: `${WORKSPACE}/status`, query: {} });
		const out = result.json<{ note: string }>();
		expect(out).toMatchObject({
			changeCount: 4,
			conflictCount: 1,
			changes: [
				{ kind: "tag", id: "12", name: "GA4 - Event - sign_up", changeStatus: "added" },
				{ kind: "trigger", id: "34", name: "Link - Outbound", changeStatus: "updated" },
				{ kind: "folder", id: "9", name: "Marketing", changeStatus: "deleted" },
				{ kind: "builtInVariable", name: "Click URL", changeStatus: "added" },
			],
			conflicts: [{ kind: "tag", id: "12", name: "GA4 - Event - sign_up" }],
		});
		// Q9: never let the model think workspace changes are live.
		expect(out.note).toContain("merge conflicts");
		expect(out.note).toContain("not live");
		expect(result.text).not.toContain("parameter");
	});

	it("Q9 says pending changes are not live yet", async () => {
		mockGtm({ [`${WORKSPACE}/status`]: reply({ workspaceChange: [{ changeStatus: "added", tag: ga4EventTag }] }) });
		const out = (await callTool("get_workspace_status", WORKSPACE_ARGS)).json();
		expect(out).toMatchObject({ changeCount: 1, conflictCount: 0 });
		expect(out.conflicts).toBeUndefined();
		expect(out.note).toMatch(/not live.*version.*publishes it in the GTM UI/);
	});

	it("reports a clean workspace", async () => {
		mockGtm({ [`${WORKSPACE}/status`]: reply({}) });
		expect((await callTool("get_workspace_status", WORKSPACE_ARGS)).json()).toEqual({
			changeCount: 0,
			conflictCount: 0,
			note: "No pending changes in this workspace.",
		});
	});

	it("maps a 404 to a not-found message", async () => {
		mockGtm({ [`${WORKSPACE}/status`]: reply(errors.notFound404, 404) });
		const result = await callTool("get_workspace_status", WORKSPACE_ARGS);
		expect(result).toMatchObject({ isError: true, text: expect.stringContaining(`Not found: ${WORKSPACE}/status.`) });
	});
});

describe("create_workspace", () => {
	it("POSTs {container}/workspaces with the name and description", async () => {
		const mock = mockGtm({
			[`${CONTAINER}/workspaces`]: reply({
				workspaceId: "9",
				name: "Add GA4 purchase",
				description: "Checkout",
				fingerprint: "1",
				path: `${CONTAINER}/workspaces/9`,
				tagManagerUrl: "https://x",
			}),
		});
		const result = await callTool("create_workspace", {
			...CONTAINER_ARGS,
			name: "Add GA4 purchase",
			description: "Checkout",
		});
		expect(mock.gtm().map(describeCall)).toMatchObject([
			{
				method: "POST",
				path: `${CONTAINER}/workspaces`,
				query: {},
				body: { name: "Add GA4 purchase", description: "Checkout" },
			},
		]);
		expect(result.json()).toEqual({
			workspace: { workspaceId: "9", name: "Add GA4 purchase", description: "Checkout" },
			note: WORKSPACE_NOT_LIVE_NOTE,
		});
	});
});

describe("quick_preview_workspace", () => {
	const PREVIEW = `${WORKSPACE}:quick_preview`;

	it("POSTs {workspace}:quick_preview and reports counts; saves nothing", async () => {
		const mock = mockGtm({
			[PREVIEW]: reply({ containerVersion: { tag: [ga4EventTag], trigger: [linkClickTrigger], folder: [folder] } }),
		});
		const result = await callTool("quick_preview_workspace", WORKSPACE_ARGS);
		expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "POST", path: PREVIEW, query: {}, body: undefined }]);
		expect(result.json()).toEqual({
			compiles: true,
			counts: { tags: 1, triggers: 1, variables: 0, folders: 1 },
			note: "Preview only: nothing was saved or published.",
		});
	});

	it.each([
		[{ compilerError: true }, "does not compile"],
		[{ syncStatus: { mergeConflict: true }, containerVersion: {} }, "merge conflicts"],
		[{ syncStatus: { syncError: true }, containerVersion: {} }, "could not sync"],
		[{}, "no preview"],
	])("Q20 shapes: %o is an error (%s)", async (response, text) => {
		const mock = mockGtm({ [PREVIEW]: reply(response) });
		const result = await callTool("quick_preview_workspace", WORKSPACE_ARGS);
		expect(result.isError).toBe(true);
		expect(result.text).toContain(text);
		expect(writes(mock.gtm())).toHaveLength(1); // the preview POST itself, nothing else
	});
});
