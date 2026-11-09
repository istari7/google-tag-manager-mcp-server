// The version-admin group: get_version, get_latest_version_header, update_version, and the
// confirm-gated delete_version, undelete_version, set_latest_version.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContainerVersion } from "../../src/gtm/generated";
import { errors, ga4EventTag, linkClickTrigger } from "../fixtures/gtm";
import { byMethod, CONTAINER, CONTAINER_ARGS, callTool, describeCall, empty, mockGtm, reply, writes } from "./helpers";

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
		expect(result.text).toContain("Changed by someone else");
		expect(writes(mock.gtm())).toHaveLength(0);
	});

	it("refuses an empty patch before calling Google", async () => {
		const mock = mockGtm();
		expect((await callTool("update_version", ARGS)).isError).toBe(true);
		expect(mock.calls).toHaveLength(0);
	});
});

describe("delete_version", () => {
	it.each([{}, { confirm: false }])("without confirm: true (%o) only reads and previews", async (extra) => {
		const mock = mockGtm({ [LIVE]: reply({ containerVersionId: "42" }), [VERSION]: byMethod({ GET: reply(v43) }) });
		const result = await callTool("delete_version", { ...ARGS, ...extra });
		expect(writes(mock.gtm())).toHaveLength(0);
		expect(result.json()).toMatchObject({
			preview: true,
			wouldDelete: { kind: "version", containerVersionId: "43", name: "Add sign_up" },
		});
		expect(result.json<{ message: string }>().message).toContain("call delete_version again with confirm: true");
	});

	it("with confirm: true checks the live version, then sends one DELETE", async () => {
		const mock = mockGtm({ [LIVE]: reply({ containerVersionId: "42" }), [VERSION]: byMethod({ DELETE: empty }) });
		const result = await callTool("delete_version", { ...ARGS, confirm: true });
		expect(mock.gtm().map((c) => `${c.method} ${describeCall(c).path}`)).toEqual([`GET ${LIVE}`, `DELETE ${VERSION}`]);
		expect(result.json()).toMatchObject({ deleted: { kind: "version", id: "43" } });
	});

	it("refuses to delete the live version, even with confirm: true", async () => {
		const mock = mockGtm({ [LIVE]: reply(v43) });
		const result = await callTool("delete_version", { ...ARGS, confirm: true });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("is the live version");
		expect(writes(mock.gtm())).toHaveLength(0);
	});

	it("deletes a version of a never-published container (live 404)", async () => {
		const mock = mockGtm({ [LIVE]: reply(errors.notFound404, 404), [VERSION]: byMethod({ DELETE: empty }) });
		await callTool("delete_version", { ...ARGS, confirm: true });
		expect(writes(mock.gtm()).map((c) => c.method)).toEqual(["DELETE"]);
	});

	it("previews an already deleted version as an error", async () => {
		mockGtm({ [LIVE]: reply({ containerVersionId: "42" }), [VERSION]: reply({ ...v43, deleted: true }) });
		const result = await callTool("delete_version", ARGS);
		expect(result).toMatchObject({ isError: true, text: "Version 43 is already deleted." });
	});
});

describe("undelete_version", () => {
	it("without confirm: true previews a deleted version, with no write", async () => {
		const mock = mockGtm({ [VERSION]: reply({ ...v43, deleted: true }) });
		const result = await callTool("undelete_version", ARGS);
		expect(writes(mock.gtm())).toHaveLength(0);
		expect(result.json()).toMatchObject({ preview: true, wouldRestore: { containerVersionId: "43", deleted: true } });
	});

	it("refuses to preview a version that is not deleted", async () => {
		mockGtm({ [VERSION]: reply(v43) });
		expect((await callTool("undelete_version", ARGS)).text).toContain("is not deleted");
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

	it("refuses a deleted version", async () => {
		mockGtm({ [VERSION]: reply({ ...v43, deleted: true }), [LATEST]: reply({ containerVersionId: "44" }) });
		expect((await callTool("set_latest_version", ARGS)).isError).toBe(true);
	});
});
