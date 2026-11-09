// The version-admin group: get_version, get_latest_version_header, update_version, and the
// confirm-gated delete_version, undelete_version, set_latest_version.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContainerVersion } from "../../src/gtm/generated";
import { errors, ga4EventTag, linkClickTrigger } from "../fixtures/gtm";
import {
	byMethod,
	CONTAINER,
	CONTAINER_ARGS,
	callTool,
	describeCall,
	empty,
	mockGtm,
	pages,
	reply,
	writes,
} from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

const VERSION = `${CONTAINER}/versions/43`;
const LIVE = `${CONTAINER}/versions:live`;
const LATEST = `${CONTAINER}/version_headers:latest`;
const ARGS = { ...CONTAINER_ARGS, containerVersionId: "43" };

const v43: ContainerVersion = {
	containerVersionId: "43",
	name: "Add sign_up",
	description: "GA4 sign_up event",
	fingerprint: "900",
	path: VERSION,
	tag: [ga4EventTag],
	trigger: [linkClickTrigger],
};

describe("get_version", () => {
	it("GETs {container}/versions/{id} and summarises it, fingerprint included", async () => {
		const mock = mockGtm({ [VERSION]: reply(v43) });
		const result = await callTool("get_version", ARGS);
		expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "GET", path: VERSION, query: {} }]);
		expect(result.json()).toEqual({
			containerVersionId: "43",
			name: "Add sign_up",
			description: "GA4 sign_up event",
			counts: { tags: 1, triggers: 1, variables: 0 },
			tags: [{ tagId: "12", name: "GA4 - Event - sign_up", type: "gaawe" }],
			triggers: [{ triggerId: "34", name: "Link - Outbound", type: "linkClick" }],
			fingerprint: "900",
		});
	});

	it("full: true returns the whole version, parameters included", async () => {
		mockGtm({ [VERSION]: reply(v43) });
		const result = await callTool("get_version", { ...ARGS, full: true });
		expect(result.json<ContainerVersion>().tag?.[0]?.parameter).toEqual(ga4EventTag.parameter);
	});

	it("rejects a non-numeric version ID before calling Google", async () => {
		const mock = mockGtm();
		expect((await callTool("get_version", { ...ARGS, containerVersionId: "live" })).isError).toBe(true);
		expect(mock.calls).toHaveLength(0);
	});
});

describe("get_latest_version_header", () => {
	it("GETs {container}/version_headers:latest", async () => {
		const mock = mockGtm({ [LATEST]: reply({ containerVersionId: "44", name: "Latest", numTags: "2", path: "x" }) });
		const result = await callTool("get_latest_version_header", CONTAINER_ARGS);
		expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "GET", path: LATEST, query: {} }]);
		expect(result.json()).toEqual({
			containerVersionId: "44",
			name: "Latest",
			numTags: 2,
			numTriggers: 0,
			numVariables: 0,
		});
	});
});

describe("update_version", () => {
	it("GETs, then PUTs only name and description with the stored ?fingerprint=", async () => {
		const mock = mockGtm({
			[VERSION]: byMethod({ GET: reply(v43), PUT: reply({ ...v43, name: "Sign-up event", fingerprint: "901" }) }),
		});
		const result = await callTool("update_version", { ...ARGS, name: "Sign-up event" });
		expect(mock.gtm().map(describeCall)).toMatchObject([
			{ method: "GET", path: VERSION },
			{
				method: "PUT",
				path: VERSION,
				query: { fingerprint: "900" },
				body: { name: "Sign-up event", description: "GA4 sign_up event" },
			},
		]);
		expect(describeCall(mock.gtm()[1]).body).toEqual({ name: "Sign-up event", description: "GA4 sign_up event" });
		expect(result.json()).toMatchObject({
			version: { containerVersionId: "43", name: "Sign-up event", fingerprint: "901" },
			note: "The live site is unchanged.",
		});
	});

	it('"" clears the description', async () => {
		const mock = mockGtm({ [VERSION]: byMethod({ GET: reply(v43), PUT: reply(v43) }) });
		await callTool("update_version", { ...ARGS, description: "" });
		expect(describeCall(mock.gtm()[1]).body).toEqual({ name: "Add sign_up", description: "" });
	});

	it("Q2: a stale fingerprint fails with a conflict and sends no PUT", async () => {
		const mock = mockGtm({ [VERSION]: byMethod({ GET: reply(v43) }) });
		const result = await callTool("update_version", { ...ARGS, name: "x", fingerprint: "1" });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("It changed since it was read");
		expect(writes(mock.gtm())).toHaveLength(0);
	});

	it("refuses an empty patch before calling Google", async () => {
		const mock = mockGtm();
		expect((await callTool("update_version", ARGS)).isError).toBe(true);
		expect(mock.calls).toHaveLength(0);
	});
});

describe("delete_version", () => {
	const latest44 = reply({ containerVersionId: "44", name: "Newest" });

	it.each([{}, { confirm: false }])("without confirm: true (%o) only reads and previews", async (extra) => {
		const mock = mockGtm({
			[LIVE]: reply({ containerVersionId: "42" }),
			[LATEST]: latest44,
			[VERSION]: byMethod({ GET: reply(v43) }),
		});
		const result = await callTool("delete_version", { ...ARGS, ...extra });
		expect(writes(mock.gtm())).toHaveLength(0);
		expect(result.json()).toMatchObject({
			preview: true,
			wouldDelete: { kind: "version", containerVersionId: "43", name: "Add sign_up" },
		});
		const { message } = result.json<{ message: string }>();
		expect(message).toContain("call delete_version again with confirm: true");
		expect(message).toContain("a workspace is still based on");
	});

	it("with confirm: true checks the live and latest versions, then sends one DELETE", async () => {
		const mock = mockGtm({
			[LIVE]: reply({ containerVersionId: "42" }),
			[LATEST]: latest44,
			[VERSION]: byMethod({ DELETE: empty }),
		});
		const result = await callTool("delete_version", { ...ARGS, confirm: true });
		expect(mock.gtm().map((c) => `${c.method} ${describeCall(c).path}`)).toEqual([
			`GET ${LIVE}`,
			`GET ${LATEST}`,
			`DELETE ${VERSION}`,
		]);
		expect(result.json()).toMatchObject({ deleted: { kind: "version", id: "43" } });
	});

	it("refuses to delete the live version, even with confirm: true", async () => {
		const mock = mockGtm({ [LIVE]: reply(v43), [LATEST]: latest44 });
		const result = await callTool("delete_version", { ...ARGS, confirm: true });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("is the live version");
		expect(writes(mock.gtm())).toHaveLength(0);
	});

	it.each([{}, { confirm: true }])("Q34 refuses the latest version before any DELETE (%o)", async (extra) => {
		const mock = mockGtm({
			[LIVE]: reply({ containerVersionId: "42" }),
			[LATEST]: reply({ containerVersionId: "43" }),
		});
		const result = await callTool("delete_version", { ...ARGS, ...extra });
		expect(result).toMatchObject({ isError: true, text: expect.stringContaining("Version 43 is the latest version") });
		expect(result.text).toContain("set_latest_version");
		expect(writes(mock.gtm())).toHaveLength(0);
	});

	it("Q34 a bare 400 on the DELETE becomes an error about workspaces still based on the version", async () => {
		mockGtm({
			[LIVE]: reply({ containerVersionId: "42" }),
			[LATEST]: latest44,
			[VERSION]: byMethod({ DELETE: reply(errors.stillInUse400, 400) }),
		});
		const result = await callTool("delete_version", { ...ARGS, confirm: true });
		expect(result).toMatchObject({
			isError: true,
			text: expect.stringContaining("Nothing was deleted: GTM refused to delete version 43."),
		});
		expect(result.text).toContain("sync_workspace");
	});

	it("deletes a version of a never-published container (live 404)", async () => {
		const mock = mockGtm({
			[LIVE]: reply(errors.notFound404, 404),
			[LATEST]: latest44,
			[VERSION]: byMethod({ DELETE: empty }),
		});
		await callTool("delete_version", { ...ARGS, confirm: true });
		expect(writes(mock.gtm()).map((c) => c.method)).toEqual(["DELETE"]);
	});

	it("previews an already deleted version as an error", async () => {
		mockGtm({
			[LIVE]: reply({ containerVersionId: "42" }),
			[LATEST]: latest44,
			[VERSION]: reply({ ...v43, deleted: true }),
		});
		const result = await callTool("delete_version", ARGS);
		expect(result).toMatchObject({ isError: true, text: "Version 43 is already deleted." });
	});
});

describe("undelete_version", () => {
	const HEADERS = `${CONTAINER}/version_headers`;
	const header43 = { containerVersionId: "43", name: "Add sign_up", numTags: "1", numTriggers: "1" };

	it("Q30 without confirm: true previews from the version list with includeDeleted, never GETting the version", async () => {
		// Google hides a deleted version from versions.get: a GET of it would 404.
		const mock = mockGtm({
			[HEADERS]: pages("containerVersionHeader", [[{ containerVersionId: "44" }], [{ ...header43, deleted: true }]]),
			[VERSION]: reply(errors.notFound404, 404),
		});
		const result = await callTool("undelete_version", ARGS);
		expect(mock.gtm().map(describeCall)).toMatchObject([
			{ method: "GET", path: HEADERS, query: { includeDeleted: "true" } },
			{ method: "GET", path: HEADERS, query: { includeDeleted: "true", pageToken: "p2" } },
		]);
		expect(result.json()).toEqual({
			preview: true,
			wouldRestore: {
				containerVersionId: "43",
				name: "Add sign_up",
				deleted: true,
				numTags: 1,
				numTriggers: 1,
				numVariables: 0,
			},
			message: "Nothing was restored. Get the user's go-ahead, then call undelete_version again with confirm: true.",
		});
	});

	it("Q30 refuses to preview a version that is not deleted", async () => {
		mockGtm({ [HEADERS]: pages("containerVersionHeader", [[header43]]) });
		expect((await callTool("undelete_version", ARGS)).text).toContain("is not deleted");
	});

	it("Q30 says so when no such version exists, deleted or not", async () => {
		mockGtm({ [HEADERS]: pages("containerVersionHeader", [[{ containerVersionId: "44" }]]) });
		const result = await callTool("undelete_version", ARGS);
		expect(result).toMatchObject({ isError: true, text: expect.stringContaining("has no version 43, deleted or not") });
	});

	it("with confirm: true POSTs {version}:undelete", async () => {
		const mock = mockGtm({ [`${VERSION}:undelete`]: byMethod({ POST: reply(v43) }) });
		const result = await callTool("undelete_version", { ...ARGS, confirm: true });
		expect(mock.gtm().map(describeCall)).toMatchObject([
			{ method: "POST", path: `${VERSION}:undelete`, query: {}, body: undefined },
		]);
		expect(result.json()).toMatchObject({ restored: { containerVersionId: "43" } });
	});
});

describe("set_latest_version", () => {
	it.each([{}, { confirm: false }])("without confirm: true (%o) only reads and previews", async (extra) => {
		const mock = mockGtm({ [VERSION]: reply(v43), [LATEST]: reply({ containerVersionId: "44", name: "Newest" }) });
		const result = await callTool("set_latest_version", { ...ARGS, ...extra });
		expect(writes(mock.gtm())).toHaveLength(0);
		expect(result.json()).toMatchObject({
			preview: true,
			wouldSetLatest: { containerVersionId: "43" },
			currentLatest: { containerVersionId: "44", name: "Newest" },
		});
		expect(result.json<{ message: string }>().message).toContain("the live site would not change");
	});

	it("with confirm: true POSTs {version}:set_latest", async () => {
		const mock = mockGtm({ [`${VERSION}:set_latest`]: byMethod({ POST: reply(v43) }) });
		const result = await callTool("set_latest_version", { ...ARGS, confirm: true });
		expect(mock.gtm().map(describeCall)).toMatchObject([
			{ method: "POST", path: `${VERSION}:set_latest`, query: {}, body: undefined },
		]);
		expect(result.json<{ note: string }>().note).toContain("The live site is unchanged.");
	});

	it("Q37 reports the new version GTM saves as a copy, not the one asked for", async () => {
		mockGtm({
			[`${VERSION}:set_latest`]: byMethod({
				POST: reply({ ...v43, containerVersionId: "45", name: "Restored_43", description: "Restored from 43" }),
			}),
		});
		const result = await callTool("set_latest_version", { ...ARGS, confirm: true });
		const out = result.json<{ latest: { containerVersionId: string }; note: string }>();
		expect(out.latest).toMatchObject({ containerVersionId: "45", name: "Restored_43" });
		expect(out.note).toContain(
			'GTM saved a copy of version 43 as new version 45 "Restored_43", which is now the latest',
		);
		expect(out.note).not.toContain("start from version 43");
	});

	it("refuses a deleted version", async () => {
		mockGtm({ [VERSION]: reply({ ...v43, deleted: true }), [LATEST]: reply({ containerVersionId: "44" }) });
		expect((await callTool("set_latest_version", ARGS)).isError).toBe(true);
	});
});
