// Server-side containers: list/get/create/update/delete for clients and transformations,
// and the clear error on a container that isn't a server container.

import { afterEach, describe, expect, it, vi } from "vitest";
import { MESSAGES } from "../../src/gtm/errors";
import { UNPUBLISHED_CHANGES_NOTE } from "../../src/gtm/quirks";
import { errors } from "../fixtures/gtm";
import {
	byMethod,
	CONTAINER,
	callTool,
	describeCall,
	empty,
	json,
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

const params = [{ type: "template", key: "path", value: "/g/collect" }];

const KINDS = [
	{
		kind: "client",
		plural: "clients",
		Plural: "Clients",
		idKey: "clientId",
		listKey: "client",
		entity: {
			clientId: "5",
			name: "GA4",
			type: "gaaw_client",
			priority: 10,
			parentFolderId: "3",
			notes: "keep",
			parameter: params,
			fingerprint: "111",
			path: `${WORKSPACE}/clients/5`,
			tagManagerUrl: "https://tagmanager.google.com/#/x",
		},
		row: { clientId: "5", name: "GA4", type: "gaaw_client", priority: 10, parentFolderId: "3" },
		create: { name: "GA4", type: "gaaw_client", priority: 10, parameter: params },
	},
	{
		kind: "transformation",
		plural: "transformations",
		Plural: "Transformations",
		idKey: "transformationId",
		listKey: "transformation",
		entity: {
			transformationId: "5",
			name: "Drop PII",
			type: "tf_exclude_params",
			parentFolderId: "3",
			notes: "keep",
			parameter: params,
			fingerprint: "111",
			path: `${WORKSPACE}/transformations/5`,
			tagManagerUrl: "https://tagmanager.google.com/#/x",
		},
		row: { transformationId: "5", name: "Drop PII", type: "tf_exclude_params", parentFolderId: "3" },
		create: { name: "Drop PII", type: "tf_exclude_params", parameter: params },
	},
] as const;

/** The bare 400 GTM gives when it won't say why (seen live for a non-empty folder delete, Q25). */
const bare400 = {
	error: { code: 400, message: "Returned an error response for your request.", status: "INVALID_ARGUMENT" },
};

const webContainer = reply({ containerId: "201", publicId: "GTM-WEB1", usageContext: ["web"] });
const serverContainer = reply({ containerId: "201", publicId: "GTM-SRV1", usageContext: ["server"] });

describe.each(KINDS)("$plural", ({ kind, plural, Plural, idKey, listKey, entity, row, create }) => {
	const LIST = `${WORKSPACE}/${plural}`;
	const ONE = `${LIST}/5`;
	const ids = { ...WORKSPACE_ARGS, [idKey]: "5" };
	const { tagManagerUrl: _link, ...stored } = entity;
	const wrongContainer = `${Plural} exist only in server-side containers; GTM-WEB1 is a web container.`;

	describe(`list_${plural}`, () => {
		it(`GETs {workspace}/${plural} across pages and returns summary rows`, async () => {
			const mock = mockGtm({ [LIST]: pages(listKey, [[entity], [{ [idKey]: "6", name: "B" }]]) });
			const result = await callTool(`list_${plural}`, WORKSPACE_ARGS);
			expect(mock.gtm().map(describeCall)).toMatchObject([
				{ method: "GET", path: LIST, query: {} },
				{ method: "GET", path: LIST, query: { pageToken: "p2" } },
			]);
			expect(result.json()).toEqual({ [plural]: [row, { [idKey]: "6", name: "B" }] });
		});

		it("an empty list on a server container is just empty", async () => {
			const mock = mockGtm({ [LIST]: reply({}), [CONTAINER]: serverContainer });
			const result = await callTool(`list_${plural}`, WORKSPACE_ARGS);
			expect(mock.gtm().map((c) => describeCall(c).path)).toEqual([LIST, CONTAINER]);
			expect(result.json()).toEqual({ [plural]: [] });
		});

		it("an empty list on a web container says it is not a server container", async () => {
			mockGtm({ [LIST]: reply({}), [CONTAINER]: webContainer });
			const result = await callTool(`list_${plural}`, WORKSPACE_ARGS);
			expect(result).toMatchObject({ isError: true, text: wrongContainer });
		});

		it.each([
			["400", bare400, 400],
			["404", errors.notFound404, 404],
		])("a %s on a web container says it is not a server container", async (_, body, status) => {
			mockGtm({ [LIST]: reply(body, status), [CONTAINER]: webContainer });
			const result = await callTool(`list_${plural}`, WORKSPACE_ARGS);
			expect(result).toMatchObject({ isError: true, text: wrongContainer });
		});
	});

	describe(`get_${kind}`, () => {
		it("GETs the path and returns the whole entity, fingerprint kept", async () => {
			const mock = mockGtm({ [ONE]: reply(entity) });
			const result = await callTool(`get_${kind}`, ids);
			expect(describeCall(mock.gtm()[0])).toMatchObject({ method: "GET", path: ONE });
			expect(result.json()).toEqual(stored);
		});

		it("a 404 on a server container keeps the not-found message", async () => {
			mockGtm({ [ONE]: reply(errors.notFound404, 404), [CONTAINER]: serverContainer });
			const result = await callTool(`get_${kind}`, ids);
			expect(result).toMatchObject({
				isError: true,
				text: `Not found: ${ONE}. Check the ${kind} ID, then the account/container/workspace IDs.`,
			});
		});

		it("a 404 on a web container says it is not a server container", async () => {
			mockGtm({ [ONE]: reply(errors.notFound404, 404), [CONTAINER]: webContainer });
			const result = await callTool(`get_${kind}`, ids);
			expect(result).toMatchObject({ isError: true, text: wrongContainer });
		});

		it("keeps Google's error when the container can't be read either", async () => {
			mockGtm({ [ONE]: reply(errors.notFound404, 404), [CONTAINER]: reply(errors.notFound404, 404) });
			const result = await callTool(`get_${kind}`, ids);
			expect(result.text).toBe(`Not found: ${ONE}. Check the ${kind} ID, then the account/container/workspace IDs.`);
		});
	});

	describe(`create_${kind}`, () => {
		it(`POSTs {workspace}/${plural} with exactly the given fields`, async () => {
			const mock = mockGtm({ [LIST]: byMethod({ POST: () => json(entity) }) });
			const result = await callTool(`create_${kind}`, { ...WORKSPACE_ARGS, ...create });
			expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "POST", path: LIST, query: {}, body: create }]);
			expect(result.json()).toEqual({ [kind]: stored, note: UNPUBLISHED_CHANGES_NOTE });
		});

		it("a 400 on a web container says it is not a server container", async () => {
			mockGtm({ [LIST]: reply(bare400, 400), [CONTAINER]: webContainer });
			const result = await callTool(`create_${kind}`, { ...WORKSPACE_ARGS, ...create });
			expect(result).toMatchObject({ isError: true, text: wrongContainer });
		});
	});

	if (kind === "client") {
		it("create_client refuses a fractional priority without calling GTM", async () => {
			const mock = mockGtm();
			const result = await callTool("create_client", { ...WORKSPACE_ARGS, ...create, priority: 1.5 });
			expect(mock.gtm()).toHaveLength(0);
			expect(result.isError).toBe(true);
			expect(result.text).toContain("priority must be a whole number");
		});
	}

	describe(`update_${kind}`, () => {
		it("Q1/Q2: GETs, then PUTs the whole merged entity with ?fingerprint=", async () => {
			const mock = mockGtm({
				[ONE]: byMethod({
					GET: () => json(entity),
					PUT: (call) => json({ ...(JSON.parse(call.body) as object), fingerprint: "112" }),
				}),
			});
			const result = await callTool(`update_${kind}`, { ...ids, name: "Renamed", fingerprint: "111" });
			const [get, put] = mock.gtm().map(describeCall);
			expect(get).toMatchObject({ method: "GET", path: ONE });
			const { fingerprint: _fp, ...body } = { ...entity, name: "Renamed" };
			expect(put).toMatchObject({ method: "PUT", path: ONE, query: { fingerprint: "111" }, body });
			expect(result.json()).toMatchObject({ [kind]: { name: "Renamed", notes: "keep", parameter: params } });
		});

		it("Q7: [] clears the parameters and the other fields are kept", async () => {
			const mock = mockGtm({
				[ONE]: byMethod({ GET: () => json(entity), PUT: (call) => json(JSON.parse(call.body)) }),
			});
			await callTool(`update_${kind}`, { ...ids, parameter: [] });
			const put = describeCall(writes(mock.gtm())[0]);
			expect(put.body).toMatchObject({ name: entity.name, notes: "keep", parentFolderId: "3", parameter: [] });
		});

		it("Q2: a stale fingerprint fails with a conflict and sends no PUT", async () => {
			const mock = mockGtm({ [ONE]: byMethod({ GET: () => json(entity) }) });
			const result = await callTool(`update_${kind}`, { ...ids, name: "X", fingerprint: "999" });
			expect(writes(mock.gtm())).toHaveLength(0);
			expect(result).toMatchObject({ isError: true, text: MESSAGES.conflict });
		});

		it("refuses an empty patch without calling GTM", async () => {
			const mock = mockGtm();
			const result = await callTool(`update_${kind}`, ids);
			expect(mock.gtm()).toHaveLength(0);
			expect(result).toMatchObject({ isError: true, text: `Nothing to update: pass at least one ${kind} field.` });
		});
	});

	describe(`delete_${kind}`, () => {
		it.each([{}, { confirm: false }])("without confirm: true (%o) only GETs and previews", async (extra) => {
			const mock = mockGtm({ [ONE]: byMethod({ GET: () => json(entity) }) });
			const result = await callTool(`delete_${kind}`, { ...ids, ...extra });
			expect(writes(mock.gtm())).toHaveLength(0);
			expect(result.json()).toEqual({
				preview: true,
				wouldDelete: { kind, ...row },
				message: `Nothing was deleted. To delete this ${kind}, get the user's go-ahead, then call delete_${kind} again with confirm: true.`,
			});
		});

		it("with confirm: true sends one DELETE", async () => {
			const mock = mockGtm({ [ONE]: byMethod({ DELETE: empty }) });
			const result = await callTool(`delete_${kind}`, { ...ids, confirm: true });
			expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "DELETE", path: ONE, body: undefined }]);
			expect(result.json()).toEqual({ deleted: { kind, id: "5" }, note: UNPUBLISHED_CHANGES_NOTE });
		});
	});
});
