// create_version (status pre-check, Q20), publish_version (confirm gating), get_live_version,
// list_versions.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContainerVersion, GetWorkspaceStatusResponse } from "../../src/gtm/generated";
import { dlvVariable, errors, folder, ga4EventTag, linkClickTrigger } from "../fixtures/gtm";
import {
	byMethod,
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

describe("get_live_version", () => {
	const live: ContainerVersion = {
		containerVersionId: "42",
		name: "Add sign_up event",
		description: "GA4 sign_up",
		fingerprint: "1",
		path: `${CONTAINER}/versions/42`,
		tagManagerUrl: "https://x",
		container: { containerId: "201", publicId: "GTM-ABC1234" },
		tag: [ga4EventTag, { tagId: "13", name: "cHTML - Chat", type: "html", paused: true }],
		trigger: [linkClickTrigger],
		variable: [dlvVariable],
		folder: [folder],
		builtInVariable: [{ type: "pageUrl", name: "Page URL" }],
	};

	it("GETs {container}/versions:live and summarises it without parameters", async () => {
		const mock = mockGtm({ [`${CONTAINER}/versions:live`]: reply(live) });
		const result = await callTool("get_live_version", CONTAINER_ARGS);
		expect(describeCall(mock.gtm()[0])).toMatchObject({
			method: "GET",
			path: `${CONTAINER}/versions:live`,
			query: {},
		});
		expect(result.json()).toEqual({
			containerVersionId: "42",
			name: "Add sign_up event",
			description: "GA4 sign_up",
			counts: { tags: 2, triggers: 1, variables: 1, folders: 1, builtInVariables: 1 },
			tags: [
				{ tagId: "12", name: "GA4 - Event - sign_up", type: "gaawe" },
				{ tagId: "13", name: "cHTML - Chat", type: "html", paused: true },
			],
			triggers: [{ triggerId: "34", name: "Link - Outbound", type: "linkClick" }],
			variables: [{ variableId: "56", name: "DLV - user_id", type: "v" }],
		});
	});

	it("explains a 404: nothing published yet, or wrong IDs", async () => {
		mockGtm({ [`${CONTAINER}/versions:live`]: reply(errors.notFound404, 404) });
		const result = await callTool("get_live_version", CONTAINER_ARGS);
		expect(result).toMatchObject({
			isError: true,
			text: `No live version for ${CONTAINER}: nothing has been published yet, or the IDs are wrong.`,
		});
	});

	it("keeps the generic mapping for other errors (403)", async () => {
		mockGtm({ [`${CONTAINER}/versions:live`]: reply(errors.forbidden403, 403) });
		const result = await callTool("get_live_version", CONTAINER_ARGS);
		expect(result.text).toBe(`No permission for ${CONTAINER}/versions:live. Check the Google account has access.`);
	});
});

describe("list_versions", () => {
	const LIVE = `${CONTAINER}/versions:live`;
	const neverPublished = { [LIVE]: reply(errors.notFound404, 404) };

	it("GETs {container}/version_headers across pages, newest first, with counts as numbers, and marks the live one", async () => {
		const mock = mockGtm({
			[`${CONTAINER}/version_headers`]: pages("containerVersionHeader", [
				[
					{ containerVersionId: "9", name: "Old", numTags: "3", numTriggers: "2", numVariables: "1", path: "x" },
					{ containerVersionId: "41", name: "Prev", numTags: "4", numTriggers: "2", numVariables: "1" },
				],
				[{ containerVersionId: "42", name: "Latest", numTags: "5", numTriggers: "3", numVariables: "2" }],
			]),
			[LIVE]: reply({ containerVersionId: "41", name: "Prev" }),
		});
		const result = await callTool("list_versions", CONTAINER_ARGS);
		expect(mock.gtm().map(describeCall)).toMatchObject([
			{ method: "GET", path: `${CONTAINER}/version_headers`, query: {} },
			{ method: "GET", path: `${CONTAINER}/version_headers`, query: { pageToken: "p2" } },
			{ method: "GET", path: LIVE, query: {} },
		]);
		expect(result.json()).toEqual({
			versions: [
				{ containerVersionId: "42", name: "Latest", numTags: 5, numTriggers: 3, numVariables: 2 },
				{ containerVersionId: "41", name: "Prev", numTags: 4, numTriggers: 2, numVariables: 1, live: true },
				{ containerVersionId: "9", name: "Old", numTags: 3, numTriggers: 2, numVariables: 1 },
			],
		});
	});

	it("marks nothing live when the container was never published (live 404)", async () => {
		mockGtm({
			[`${CONTAINER}/version_headers`]: reply({ containerVersionHeader: [{ containerVersionId: "1", name: "v1" }] }),
			...neverPublished,
		});
		const result = await callTool("list_versions", CONTAINER_ARGS);
		expect(result.json()).toEqual({
			versions: [{ containerVersionId: "1", name: "v1", numTags: 0, numTriggers: 0, numVariables: 0 }],
		});
	});

	it("passes includeDeleted as a query parameter", async () => {
		const mock = mockGtm({
			[`${CONTAINER}/version_headers`]: reply({
				containerVersionHeader: [{ containerVersionId: "3", name: "Gone", deleted: true }],
			}),
			...neverPublished,
		});
		const result = await callTool("list_versions", { ...CONTAINER_ARGS, includeDeleted: true });
		expect(describeCall(mock.gtm()[0]).query).toEqual({ includeDeleted: "true" });
		expect(result.json()).toEqual({
			versions: [{ containerVersionId: "3", name: "Gone", deleted: true, numTags: 0, numTriggers: 0, numVariables: 0 }],
		});
	});

	it("reports counts Google omits (zero) as 0, like get_live_version", async () => {
		mockGtm({
			[`${CONTAINER}/version_headers`]: reply({
				containerVersionHeader: [
					{ containerVersionId: "2", name: "Tags only", numTags: "1" },
					{ containerVersionId: "1", name: "Empty" },
				],
			}),
			...neverPublished,
		});
		const result = await callTool("list_versions", CONTAINER_ARGS);
		expect(result.json()).toEqual({
			versions: [
				{ containerVersionId: "2", name: "Tags only", numTags: 1, numTriggers: 0, numVariables: 0 },
				{ containerVersionId: "1", name: "Empty", numTags: 0, numTriggers: 0, numVariables: 0 },
			],
		});
	});
});

describe("create_version", () => {
	const STATUS = `${WORKSPACE}/status`;
	const CREATE = `${WORKSPACE}:create_version`;
	const pending: GetWorkspaceStatusResponse = { workspaceChange: [{ changeStatus: "added", tag: ga4EventTag }] };
	const created: ContainerVersion = {
		containerVersionId: "43",
		name: "Add sign_up",
		description: "GA4 sign_up event",
		tag: [ga4EventTag],
		trigger: [linkClickTrigger],
		fingerprint: "1",
		path: `${CONTAINER}/versions/43`,
	};
	const ARGS = { ...WORKSPACE_ARGS, name: "Add sign_up", notes: "GA4 sign_up event" };

	it("GETs the workspace status, then POSTs {workspace}:create_version with name and notes", async () => {
		const mock = mockGtm({
			[STATUS]: reply(pending),
			[CREATE]: reply({ containerVersion: created, newWorkspacePath: `${CONTAINER}/workspaces/8` }),
		});
		const result = await callTool("create_version", ARGS);
		expect(mock.gtm().map(describeCall)).toMatchObject([
			{ method: "GET", path: STATUS, query: {} },
			{ method: "POST", path: CREATE, query: {}, body: { name: "Add sign_up", notes: "GA4 sign_up event" } },
		]);
		const out = result.json<{ version: unknown; note: string }>();
		expect(out.version).toEqual({
			containerVersionId: "43",
			name: "Add sign_up",
			description: "GA4 sign_up event",
			counts: { tags: 1, triggers: 1, variables: 0 },
		});
		expect(out.note).toContain("Version 43 is saved but NOT live");
		expect(out.note).toContain("get the user's explicit go-ahead and call publish_version");
		expect(out.note).toContain("GTM replaced workspace 7 with workspace 8");
	});

	it("refuses a workspace with no changes: no create_version call", async () => {
		const mock = mockGtm({ [STATUS]: reply({}) });
		const result = await callTool("create_version", ARGS);
		expect(result).toMatchObject({
			isError: true,
			text: "Workspace 7 has no changes, so there is nothing to version.",
		});
		expect(writes(mock.gtm())).toHaveLength(0);
	});

	it("refuses a workspace with merge conflicts, naming them: no create_version call", async () => {
		const mock = mockGtm({
			[STATUS]: reply({
				...pending,
				mergeConflict: [{ entityInWorkspace: { changeStatus: "updated", trigger: linkClickTrigger } }],
			}),
		});
		const result = await callTool("create_version", ARGS);
		expect(result.isError).toBe(true);
		expect(result.text).toBe(
			'Workspace 7 has 1 merge conflict(s) (trigger 34 "Link - Outbound"). Resolve them in the GTM UI, then retry. No version was created.',
		);
		expect(writes(mock.gtm())).toHaveLength(0);
	});

	it.each([
		[{ compilerError: true }, "could not compile"],
		[{ syncStatus: { mergeConflict: true } }, "merge conflicts"],
		[{ syncStatus: { syncError: true } }, "could not sync"],
		[{}, "No version was created"],
	])("Q20: a 200 with %o is an error (%s)", async (response, text) => {
		mockGtm({ [STATUS]: reply(pending), [CREATE]: reply(response) });
		const result = await callTool("create_version", ARGS);
		expect(result.isError).toBe(true);
		expect(result.text).toContain(text);
	});

	it("requires a version name", async () => {
		const mock = mockGtm();
		expect((await callTool("create_version", WORKSPACE_ARGS)).isError).toBe(true);
		expect(mock.calls).toHaveLength(0);
	});
});

describe("publish_version", () => {
	const VERSION = `${CONTAINER}/versions/43`;
	const LIVE = `${CONTAINER}/versions:live`;
	const ARGS = { ...CONTAINER_ARGS, containerVersionId: "43" };
	const v43: ContainerVersion = {
		containerVersionId: "43",
		name: "Add sign_up",
		tag: [ga4EventTag],
		trigger: [linkClickTrigger],
		path: VERSION,
	};

	it("the preview spells out every tag's paused state (active tags fire once published)", async () => {
		const html = { tagId: "13", name: "cHTML - Chat", type: "html", paused: true };
		mockGtm({
			[VERSION]: reply({ ...v43, tag: [ga4EventTag, html] }),
			[LIVE]: reply({ containerVersionId: "42", name: "Empty Container" }),
		});
		const result = await callTool("publish_version", ARGS);
		expect(result.json<{ wouldPublish: { tags: unknown } }>().wouldPublish.tags).toEqual([
			{ tagId: "12", name: "GA4 - Event - sign_up", type: "gaawe", paused: false },
			{ tagId: "13", name: "cHTML - Chat", type: "html", paused: true },
		]);
	});

	it.each([{}, { confirm: false }])("without confirm: true (%o) only reads and previews", async (extra) => {
		const mock = mockGtm({
			[VERSION]: reply(v43),
			[LIVE]: reply({ containerVersionId: "42", name: "Empty Container" }),
		});
		const result = await callTool("publish_version", { ...ARGS, ...extra });
		expect(writes(mock.gtm())).toHaveLength(0);
		expect(
			mock
				.gtm()
				.map((c) => describeCall(c).path)
				.sort(),
		).toEqual([VERSION, LIVE].sort());
		expect(result.json()).toEqual({
			preview: true,
			wouldPublish: {
				containerVersionId: "43",
				name: "Add sign_up",
				counts: { tags: 1, triggers: 1, variables: 0 },
				tags: [{ tagId: "12", name: "GA4 - Event - sign_up", type: "gaawe", paused: false }],
				triggers: [{ triggerId: "34", name: "Link - Outbound", type: "linkClick" }],
			},
			currentlyLive: { containerVersionId: "42", name: "Empty Container" },
			message:
				"Nothing was published. Show the user what this version contains and what is live now, get their explicit go-ahead, then call publish_version again with confirm: true.",
		});
	});

	it("previews a container that was never published, and flags a version that is already live", async () => {
		mockGtm({ [VERSION]: reply(v43), [LIVE]: reply(errors.notFound404, 404) });
		expect((await callTool("publish_version", ARGS)).json()).toMatchObject({
			currentlyLive: "nothing (this container has never been published)",
		});
		vi.restoreAllMocks();
		mockGtm({ [VERSION]: reply(v43), [LIVE]: reply(v43) });
		expect((await callTool("publish_version", ARGS)).json()).toMatchObject({ alreadyLive: true });
	});

	it("refuses to preview a deleted version", async () => {
		mockGtm({ [VERSION]: reply({ ...v43, deleted: true }), [LIVE]: reply(v43) });
		const result = await callTool("publish_version", ARGS);
		expect(result).toMatchObject({ isError: true, text: "Version 43 is deleted, so it cannot be published." });
	});

	it("with confirm: true sends one POST {version}:publish and says it is live", async () => {
		const mock = mockGtm({ [`${VERSION}:publish`]: byMethod({ POST: reply({ containerVersion: v43 }) }) });
		const result = await callTool("publish_version", { ...ARGS, confirm: true });
		expect(mock.gtm().map(describeCall)).toMatchObject([
			{ method: "POST", path: `${VERSION}:publish`, query: {}, body: undefined },
		]);
		expect(result.json()).toEqual({
			published: { containerVersionId: "43", name: "Add sign_up", counts: { tags: 1, triggers: 1, variables: 0 } },
			note: "Version 43 is now LIVE on every site that loads this container. To roll back, publish an earlier version (list_versions).",
		});
	});

	it("reports a compiler error as nothing published", async () => {
		mockGtm({ [`${VERSION}:publish`]: reply({ compilerError: true }) });
		const result = await callTool("publish_version", { ...ARGS, confirm: true });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("does not compile, so nothing was published");
	});

	it("passes on Google's missing-scope error", async () => {
		mockGtm({ [`${VERSION}:publish`]: reply(errors.scope403, 403) });
		const result = await callTool("publish_version", { ...ARGS, confirm: true });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("did not grant the permission");
	});
});
