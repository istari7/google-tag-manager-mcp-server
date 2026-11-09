// Workspace entities: list_tags/get_tag, list_triggers/get_trigger, list_variables/get_variable,
// list_folders, list_built_in_variables.

import { afterEach, describe, expect, it, vi } from "vitest";
import { dlvVariable, errors, folder, ga4EventTag, linkClickTrigger } from "../fixtures/gtm";
import { callTool, describeCall, mockGtm, pages, reply, WORKSPACE, WORKSPACE_ARGS } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("list_tags", () => {
	it("GETs {workspace}/tags and returns summary rows without fingerprints or parameters", async () => {
		const mock = mockGtm({
			[`${WORKSPACE}/tags`]: reply({
				tag: [ga4EventTag, { tagId: "13", name: "cHTML - Chat", type: "html", paused: true, firingTriggerId: [] }],
			}),
		});
		const result = await callTool("list_tags", WORKSPACE_ARGS);
		expect(describeCall(mock.gtm()[0])).toMatchObject({ method: "GET", path: `${WORKSPACE}/tags`, query: {} });
		expect(result.json()).toEqual({
			tags: [
				{
					tagId: "12",
					name: "GA4 - Event - sign_up",
					type: "gaawe",
					parentFolderId: "9",
					firingTriggerId: ["34"],
					blockingTriggerId: ["35"],
				},
				{ tagId: "13", name: "cHTML - Chat", type: "html", paused: true },
			],
		});
	});

	it("reads every page (Q18)", async () => {
		const mock = mockGtm({
			[`${WORKSPACE}/tags`]: pages("tag", [[{ tagId: "1", name: "A" }], [{ tagId: "2", name: "B" }]]),
		});
		const result = await callTool("list_tags", WORKSPACE_ARGS);
		expect(result.json()).toEqual({
			tags: [
				{ tagId: "1", name: "A" },
				{ tagId: "2", name: "B" },
			],
		});
		expect(mock.gtm().map((c) => describeCall(c).query)).toEqual([{}, { pageToken: "p2" }]);
	});

	it("flags a list cut off at the page cap", async () => {
		// Every page points to a new one: listAll stops after 20 pages.
		mockGtm({
			[`${WORKSPACE}/tags`]: (call) => {
				const n = Number(new URL(call.url).searchParams.get("pageToken") ?? "0");
				return new Response(JSON.stringify({ tag: [{ tagId: String(n) }], nextPageToken: String(n + 1) }));
			},
		});
		const out = (await callTool("list_tags", WORKSPACE_ARGS)).json<{ tags: unknown[]; truncated: boolean }>();
		expect(out.tags).toHaveLength(20);
		expect(out.truncated).toBe(true);
	});
});

describe("get_tag", () => {
	it("GETs the tag path and returns the full tag without the UI link, keeping the fingerprint", async () => {
		const mock = mockGtm({ [`${WORKSPACE}/tags/12`]: reply(ga4EventTag) });
		const result = await callTool("get_tag", { ...WORKSPACE_ARGS, tagId: "12" });
		expect(describeCall(mock.gtm()[0])).toMatchObject({ method: "GET", path: `${WORKSPACE}/tags/12`, query: {} });
		const { tagManagerUrl: _dropped, ...expected } = ga4EventTag;
		expect(result.json()).toEqual(expected);
	});

	it("maps a 404 to a not-found message", async () => {
		mockGtm({ [`${WORKSPACE}/tags/99`]: reply(errors.notFound404, 404) });
		const result = await callTool("get_tag", { ...WORKSPACE_ARGS, tagId: "99" });
		expect(result).toMatchObject({
			isError: true,
			text: `Not found: ${WORKSPACE}/tags/99. Check the account/container/workspace IDs.`,
		});
	});
});

describe("list_triggers / get_trigger", () => {
	it("list_triggers returns id, name, type and folder", async () => {
		const mock = mockGtm({ [`${WORKSPACE}/triggers`]: reply({ trigger: [linkClickTrigger] }) });
		const result = await callTool("list_triggers", WORKSPACE_ARGS);
		expect(describeCall(mock.gtm()[0])).toMatchObject({ method: "GET", path: `${WORKSPACE}/triggers` });
		expect(result.json()).toEqual({
			triggers: [{ triggerId: "34", name: "Link - Outbound", type: "linkClick", parentFolderId: "9" }],
		});
	});

	it("get_trigger returns the conditions", async () => {
		const mock = mockGtm({ [`${WORKSPACE}/triggers/34`]: reply(linkClickTrigger) });
		const result = await callTool("get_trigger", { ...WORKSPACE_ARGS, triggerId: "34" });
		expect(describeCall(mock.gtm()[0])).toMatchObject({ method: "GET", path: `${WORKSPACE}/triggers/34` });
		expect(result.json()).toEqual(linkClickTrigger);
	});
});

describe("list_variables / get_variable", () => {
	it("list_variables returns id, name, type and folder across pages", async () => {
		const mock = mockGtm({
			[`${WORKSPACE}/variables`]: pages("variable", [
				[dlvVariable],
				[{ variableId: "57", name: "CONST - ID", type: "c" }],
			]),
		});
		const result = await callTool("list_variables", WORKSPACE_ARGS);
		expect(result.json()).toEqual({
			variables: [
				{ variableId: "56", name: "DLV - user_id", type: "v", parentFolderId: "9" },
				{ variableId: "57", name: "CONST - ID", type: "c" },
			],
		});
		expect(mock.gtm()).toHaveLength(2);
	});

	it("get_variable returns the parameters and fingerprint", async () => {
		const mock = mockGtm({ [`${WORKSPACE}/variables/56`]: reply(dlvVariable) });
		const result = await callTool("get_variable", { ...WORKSPACE_ARGS, variableId: "56" });
		expect(describeCall(mock.gtm()[0])).toMatchObject({ method: "GET", path: `${WORKSPACE}/variables/56` });
		expect(result.json()).toEqual(dlvVariable);
	});
});

describe("list_folders", () => {
	it("GETs {workspace}/folders and returns id + name (+ notes when set)", async () => {
		const mock = mockGtm({
			[`${WORKSPACE}/folders`]: reply({ folder: [folder, { folderId: "10", name: "Consent", notes: "CMP tags" }] }),
		});
		const result = await callTool("list_folders", WORKSPACE_ARGS);
		expect(describeCall(mock.gtm()[0])).toMatchObject({ method: "GET", path: `${WORKSPACE}/folders` });
		expect(result.json()).toEqual({
			folders: [
				{ folderId: "9", name: "Marketing" },
				{ folderId: "10", name: "Consent", notes: "CMP tags" },
			],
		});
	});
});

describe("list_built_in_variables", () => {
	it("GETs {workspace}/built_in_variables and returns type + name", async () => {
		const mock = mockGtm({
			[`${WORKSPACE}/built_in_variables`]: pages("builtInVariable", [
				[{ type: "pageUrl", name: "Page URL", path: `${WORKSPACE}/built_in_variables`, workspaceId: "7" }],
				[{ type: "clickClasses", name: "Click Classes" }],
			]),
		});
		const result = await callTool("list_built_in_variables", WORKSPACE_ARGS);
		expect(mock.gtm().map(describeCall)).toMatchObject([
			{ method: "GET", path: `${WORKSPACE}/built_in_variables`, query: {} },
			{ method: "GET", path: `${WORKSPACE}/built_in_variables`, query: { pageToken: "p2" } },
		]);
		expect(result.json()).toEqual({
			builtInVariables: [
				{ type: "pageUrl", name: "Page URL" },
				{ type: "clickClasses", name: "Click Classes" },
			],
		});
	});
});
