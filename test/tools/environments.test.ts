// Environments (container level, not versioned): requests sent, Q1/Q2 merge on update,
// confirm gating for repointing, reauthorizing and deleting, and the user-only field rules.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "../../src/gtm/generated";
import { ENVIRONMENT_NOTE } from "../../src/tools/environments";
import {
	byMethod,
	CONTAINER,
	CONTAINER_ARGS,
	callTool,
	describeCall,
	empty,
	json,
	mockGtm,
	pages,
	writes,
} from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

const ENV = `${CONTAINER}/environments/5`;
const ENV_ARGS = { ...CONTAINER_ARGS, environmentId: "5" };
const staging: Environment = {
	environmentId: "5",
	name: "Staging",
	type: "user",
	url: "https://staging.example.com",
	enableDebug: false,
	containerVersionId: "40",
	authorizationCode: "auth-code-old",
	authorizationTimestamp: "2026-11-01T00:00:00Z",
	fingerprint: "1",
	path: ENV,
};
const live: Environment = { environmentId: "1", name: "Live", type: "live", fingerprint: "3" };
const { fingerprint: STORED_FINGERPRINT, ...storedBody } = staging;
const STAGING_ROW = {
	environmentId: "5",
	name: "Staging",
	type: "user",
	url: "https://staging.example.com",
	containerVersionId: "40",
};

function routes(stored: Environment = staging) {
	return {
		[ENV]: byMethod({
			GET: () => json(stored),
			PUT: (call) => json({ ...(JSON.parse(call.body) as Environment), fingerprint: "2" }),
			DELETE: empty,
		}),
	};
}

describe("list_environments / get_environment", () => {
	it("list_environments GETs {container}/environments across pages, without auth codes", async () => {
		const mock = mockGtm({ [`${CONTAINER}/environments`]: pages("environment", [[staging], [live]]) });
		const result = await callTool("list_environments", CONTAINER_ARGS);
		expect(mock.gtm()).toHaveLength(2);
		expect(result.json()).toEqual({
			environments: [STAGING_ROW, { environmentId: "1", name: "Live", type: "live" }],
		});
	});

	it("get_environment returns the whole environment, auth code and fingerprint included", async () => {
		const mock = mockGtm(routes());
		const result = await callTool("get_environment", ENV_ARGS);
		expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "GET", path: ENV }]);
		expect(result.json()).toEqual(staging);
	});
});

describe("create_environment", () => {
	it("POSTs {container}/environments as a user environment", async () => {
		const mock = mockGtm({
			[`${CONTAINER}/environments`]: (call) => json({ ...(JSON.parse(call.body) as Environment), environmentId: "6" }),
		});
		const result = await callTool("create_environment", {
			...CONTAINER_ARGS,
			name: "QA",
			url: "https://qa.example.com",
			enableDebug: true,
		});
		expect(describeCall(mock.gtm()[0])).toMatchObject({
			method: "POST",
			path: `${CONTAINER}/environments`,
			query: {},
			body: { name: "QA", url: "https://qa.example.com", enableDebug: true, type: "user" },
		});
		expect(result.json()).toMatchObject({ environment: { environmentId: "6" }, note: ENVIRONMENT_NOTE });
	});
});

describe("update_environment", () => {
	it("Q1/Q2: a rename GETs, then PUTs the whole merged environment with ?fingerprint=, no confirm needed", async () => {
		const mock = mockGtm(routes());
		const result = await callTool("update_environment", {
			...ENV_ARGS,
			name: "Staging 2",
			enableDebug: true,
			fingerprint: STORED_FINGERPRINT,
		});
		const calls = mock.gtm().map(describeCall);
		expect(calls.map((c) => [c.method, c.path, c.query])).toEqual([
			["GET", ENV, {}],
			["PUT", ENV, { fingerprint: STORED_FINGERPRINT }],
		]);
		expect(calls[1]?.body).toEqual({ ...storedBody, name: "Staging 2", enableDebug: true });
		expect(result.json()).toMatchObject({ environment: { name: "Staging 2" }, note: ENVIRONMENT_NOTE });
	});

	it.each([{}, { confirm: false }])("repointing without confirm: true (%o) only previews", async (extra) => {
		const mock = mockGtm(routes());
		const result = await callTool("update_environment", { ...ENV_ARGS, containerVersionId: "41", ...extra });
		expect(writes(mock.gtm())).toHaveLength(0);
		expect(result.json()).toMatchObject({
			preview: true,
			environment: STAGING_ROW,
			wouldServe: { containerVersionId: "41" },
		});
	});

	it("repointing with confirm: true PUTs the new version", async () => {
		const mock = mockGtm(routes());
		await callTool("update_environment", { ...ENV_ARGS, containerVersionId: "41", confirm: true });
		const calls = mock.gtm().map(describeCall);
		expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
		expect(calls[1]?.body).toEqual({ ...storedBody, containerVersionId: "41" });
	});

	it("repointing to a workspace drops the stored version from the PUT body", async () => {
		const mock = mockGtm(routes());
		await callTool("update_environment", { ...ENV_ARGS, workspaceId: "7", confirm: true });
		const body = describeCall(mock.gtm()[1]).body as Environment;
		const { containerVersionId: _old, ...rest } = storedBody;
		expect(body).toEqual({ ...rest, workspaceId: "7" });
		expect(body).not.toHaveProperty("containerVersionId");
	});

	it("repointing to a version drops the stored workspace from the PUT body", async () => {
		const mock = mockGtm(routes({ ...staging, containerVersionId: undefined, workspaceId: "7" }));
		await callTool("update_environment", { ...ENV_ARGS, containerVersionId: "41", confirm: true });
		const body = describeCall(mock.gtm()[1]).body as Environment;
		expect(body).toMatchObject({ containerVersionId: "41" });
		expect(body).not.toHaveProperty("workspaceId");
	});

	it("refuses a version and a workspace at once, with no call", async () => {
		const mock = mockGtm(routes());
		const result = await callTool("update_environment", {
			...ENV_ARGS,
			containerVersionId: "41",
			workspaceId: "7",
			confirm: true,
		});
		expect(result).toMatchObject({ isError: true, text: expect.stringContaining("pass one of them") });
		expect(mock.gtm()).toHaveLength(0);
	});

	it("refuses name or version changes on a non-user environment, with no PUT", async () => {
		const mock = mockGtm(routes(live));
		const result = await callTool("update_environment", {
			...ENV_ARGS,
			name: "x",
			containerVersionId: "41",
			confirm: true,
		});
		expect(result).toMatchObject({ isError: true, text: expect.stringContaining("name, containerVersionId") });
		expect(writes(mock.gtm())).toHaveLength(0);
	});

	it("allows url on a non-user environment", async () => {
		const mock = mockGtm(routes(live));
		await callTool("update_environment", { ...ENV_ARGS, url: "https://example.com" });
		const { fingerprint, ...liveBody } = live;
		expect(describeCall(mock.gtm()[1])).toMatchObject({
			method: "PUT",
			query: { fingerprint },
			body: { ...liveBody, url: "https://example.com" },
		});
	});

	// Live: Google sends no `type` on user environments (get/list), only on Live/Latest/workspace.
	const { type: _type, ...untyped } = staging;

	it("Q29 an environment without type is a user one: rename, describe and repoint all go through", async () => {
		const mock = mockGtm(routes(untyped));
		const result = await callTool("update_environment", {
			...ENV_ARGS,
			name: "Staging 2",
			description: "temp env (updated)",
			fingerprint: STORED_FINGERPRINT,
		});
		expect(result.isError).toBe(false);
		const { fingerprint: _fp, ...untypedBody } = untyped;
		expect(describeCall(mock.gtm()[1])).toMatchObject({
			method: "PUT",
			query: { fingerprint: STORED_FINGERPRINT },
			body: { ...untypedBody, name: "Staging 2", description: "temp env (updated)" },
		});
		expect(result.text).not.toContain("undefined");
	});

	it("Q29 repointing an environment without type previews it as a user environment", async () => {
		const mock = mockGtm(routes(untyped));
		const result = await callTool("update_environment", { ...ENV_ARGS, containerVersionId: "41" });
		expect(writes(mock.gtm())).toHaveLength(0);
		expect(result.json()).toMatchObject({
			preview: true,
			environment: STAGING_ROW,
			wouldServe: { containerVersionId: "41" },
		});
	});

	it("Q29 list_environments shows type user when Google leaves it out", async () => {
		mockGtm({ [`${CONTAINER}/environments`]: pages("environment", [[untyped]]) });
		const result = await callTool("list_environments", CONTAINER_ARGS);
		expect(result.json()).toEqual({ environments: [STAGING_ROW] });
	});

	it("refuses user-only fields on a workspace environment, naming its type", async () => {
		const mock = mockGtm(routes({ ...live, type: "workspace" }));
		const result = await callTool("update_environment", { ...ENV_ARGS, description: "x" });
		expect(result).toMatchObject({
			isError: true,
			text: 'Nothing was changed: on a "workspace" environment Google only allows url and enableDebug to change, not description.',
		});
		expect(writes(mock.gtm())).toHaveLength(0);
	});

	it("Q2: a stale fingerprint fails with a conflict and sends no PUT", async () => {
		const mock = mockGtm(routes());
		const result = await callTool("update_environment", { ...ENV_ARGS, url: "", fingerprint: "0" });
		expect(result).toMatchObject({ isError: true, text: expect.stringContaining("It changed since it was read") });
		expect(writes(mock.gtm())).toHaveLength(0);
	});
});

describe("reauthorize_environment", () => {
	it.each([{}, { confirm: false }])("without confirm: true (%o) only GETs and previews", async (extra) => {
		const mock = mockGtm(routes());
		const result = await callTool("reauthorize_environment", { ...ENV_ARGS, ...extra });
		expect(writes(mock.gtm())).toHaveLength(0);
		expect(result.json()).toMatchObject({ preview: true, environment: STAGING_ROW });
		expect(result.text).not.toContain("auth-code-old");
	});

	it("with confirm: true POSTs {environment}:reauthorize and returns the new code", async () => {
		const mock = mockGtm({
			[`${ENV}:reauthorize`]: () =>
				json({ ...staging, authorizationCode: "auth-code-new", authorizationTimestamp: "2026-11-09T00:00:00Z" }),
		});
		const result = await callTool("reauthorize_environment", { ...ENV_ARGS, confirm: true });
		expect(mock.gtm().map(describeCall)).toMatchObject([
			{ method: "POST", path: `${ENV}:reauthorize`, query: {}, body: {} },
		]);
		expect(result.json()).toMatchObject({
			environment: { environmentId: "5", authorizationCode: "auth-code-new" },
		});
	});
});

describe("delete_environment", () => {
	it("without confirm only GETs and previews", async () => {
		const mock = mockGtm(routes());
		const result = await callTool("delete_environment", ENV_ARGS);
		expect(writes(mock.gtm())).toHaveLength(0);
		expect(result.json()).toMatchObject({ preview: true, wouldDelete: { kind: "environment", ...STAGING_ROW } });
	});

	it("with confirm: true sends one DELETE", async () => {
		const mock = mockGtm(routes());
		const result = await callTool("delete_environment", { ...ENV_ARGS, confirm: true });
		expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "DELETE", path: ENV, query: {} }]);
		expect(result.json()).toEqual({ deleted: { kind: "environment", id: "5" }, note: ENVIRONMENT_NOTE });
	});
});
