// list/get/create/update/delete_zone: requests sent, Q5 boundary conditions, Q1/Q2/Q7 merge
// (one level down for the boundary and type restriction), confirm gating.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Condition, Zone } from "../../src/gtm/generated";
import { UNPUBLISHED_CHANGES_NOTE } from "../../src/gtm/quirks";
import {
	byMethod,
	callTool,
	describeCall,
	empty,
	json,
	mockGtm,
	pages,
	WORKSPACE,
	WORKSPACE_ARGS,
	writes,
} from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

const ZONE = `${WORKSPACE}/zones/4`;
const ZONE_ARGS = { ...WORKSPACE_ARGS, zoneId: "4" };
const urlContains = (value: string) =>
	({
		type: "contains",
		parameter: [
			{ type: "template", key: "arg0", value: "{{Page URL}}" },
			{ type: "template", key: "arg1", value },
		],
	}) satisfies Condition;
const zone: Zone = {
	zoneId: "4",
	name: "Checkout",
	notes: "Partner widgets",
	fingerprint: "1",
	path: ZONE,
	boundary: { condition: [urlContains("/checkout")], customEvaluationTriggerId: ["12"] },
	childContainer: [{ publicId: "GTM-CHILD1", nickname: "Widgets" }],
	typeRestriction: { enable: true, whitelistedTypeId: ["html"] },
};
const { fingerprint: STORED_FINGERPRINT, ...storedBody } = zone;

function routes() {
	return {
		[ZONE]: byMethod({
			GET: () => json(zone),
			PUT: (call) => json({ ...(JSON.parse(call.body) as Zone), fingerprint: "2" }),
		}),
	};
}

describe("list_zones / get_zone", () => {
	it("list_zones GETs {workspace}/zones across pages, one short row per zone", async () => {
		const mock = mockGtm({ [`${WORKSPACE}/zones`]: pages("zone", [[zone], [{ zoneId: "5", name: "Blog" }]]) });
		const result = await callTool("list_zones", WORKSPACE_ARGS);
		expect(mock.gtm()).toHaveLength(2);
		expect(result.json()).toEqual({
			zones: [
				{ zoneId: "4", name: "Checkout", childContainers: ["GTM-CHILD1"], typeRestriction: true },
				{ zoneId: "5", name: "Blog" },
			],
		});
	});

	it("get_zone returns the whole zone, fingerprint included", async () => {
		const mock = mockGtm(routes());
		const result = await callTool("get_zone", ZONE_ARGS);
		expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "GET", path: ZONE }]);
		expect(result.json()).toEqual(zone);
	});
});

describe("create_zone", () => {
	it("POSTs {workspace}/zones with the boundary built from condition + customEvaluationTriggerId (Q5 applied)", async () => {
		const mock = mockGtm({
			[`${WORKSPACE}/zones`]: (call) => json({ ...(JSON.parse(call.body) as Zone), zoneId: "9" }),
		});
		const result = await callTool("create_zone", {
			...WORKSPACE_ARGS,
			name: "Checkout",
			condition: JSON.stringify([{ ...urlContains("/test"), type: "doesNotContain" }]),
			customEvaluationTriggerId: ["12"],
			childContainer: [{ publicId: "gtm-child1 " }],
			typeRestriction: { enable: true, whitelistedTypeId: ["html"] },
		});
		expect(describeCall(mock.gtm()[0])).toMatchObject({
			method: "POST",
			path: `${WORKSPACE}/zones`,
			query: {},
		});
		expect(describeCall(mock.gtm()[0]).body).toEqual({
			name: "Checkout",
			boundary: {
				condition: [
					{
						type: "contains",
						parameter: [...urlContains("/test").parameter, { type: "boolean", key: "negate", value: "true" }],
					},
				],
				customEvaluationTriggerId: ["12"],
			},
			childContainer: [{ publicId: "GTM-CHILD1" }],
			typeRestriction: { enable: true, whitelistedTypeId: ["html"] },
		});
		expect(result.json()).toMatchObject({ zone: { zoneId: "9" }, note: UNPUBLISHED_CHANGES_NOTE });
	});

	it("refuses condition text that is not a JSON array of conditions, without calling Google", async () => {
		const mock = mockGtm({});
		for (const condition of ["not json", '{"type":"equals"}', '[{"type":"bogus","parameter":[]}]']) {
			const result = await callTool("create_zone", { ...WORKSPACE_ARGS, name: "Z", condition });
			expect(result.isError, condition).toBe(true);
		}
		expect(mock.gtm()).toHaveLength(0);
	});

	it("refuses a child container that is not a public ID", async () => {
		const mock = mockGtm({});
		const result = await callTool("create_zone", {
			...WORKSPACE_ARGS,
			name: "Z",
			childContainer: [{ publicId: "123" }],
		});
		expect(result.isError).toBe(true);
		expect(mock.gtm()).toHaveLength(0);
	});
});

describe("update_zone", () => {
	it("Q1/Q2: GET, then PUT of the whole merged zone with ?fingerprint=", async () => {
		const mock = mockGtm(routes());
		const result = await callTool("update_zone", {
			...ZONE_ARGS,
			name: "Checkout v2",
			fingerprint: STORED_FINGERPRINT,
		});
		const calls = mock.gtm().map(describeCall);
		expect(calls.map((c) => [c.method, c.path, c.query])).toEqual([
			["GET", ZONE, {}],
			["PUT", ZONE, { fingerprint: STORED_FINGERPRINT }],
		]);
		expect(calls[1]?.body).toEqual({ ...storedBody, name: "Checkout v2" });
		expect(result.json()).toMatchObject({
			zone: { name: "Checkout v2", fingerprint: "2" },
			note: UNPUBLISHED_CHANGES_NOTE,
		});
	});

	it("Q7 one level down: new conditions keep the stored evaluation triggers; [] clears", async () => {
		const mock = mockGtm(routes());
		await callTool("update_zone", { ...ZONE_ARGS, condition: JSON.stringify([urlContains("/cart")]) });
		expect((describeCall(mock.gtm()[1]).body as Zone).boundary).toEqual({
			condition: [urlContains("/cart")],
			customEvaluationTriggerId: ["12"],
		});

		mock.calls.length = 0;
		await callTool("update_zone", { ...ZONE_ARGS, condition: "[]" });
		expect((describeCall(mock.gtm()[1]).body as Zone).boundary).toEqual({
			condition: [],
			customEvaluationTriggerId: ["12"],
		});
	});

	it("typeRestriction: changing enable keeps the stored allowed types; childContainer [] clears", async () => {
		const mock = mockGtm(routes());
		await callTool("update_zone", { ...ZONE_ARGS, typeRestriction: { enable: false }, childContainer: [] });
		const body = describeCall(mock.gtm()[1]).body as Zone;
		expect(body.typeRestriction).toEqual({ enable: false, whitelistedTypeId: ["html"] });
		expect(body.childContainer).toEqual([]);
		expect(body.notes).toBe("Partner widgets");
	});

	it("Q2: a stale fingerprint fails with a conflict and sends no PUT", async () => {
		const mock = mockGtm(routes());
		const result = await callTool("update_zone", { ...ZONE_ARGS, notes: "", fingerprint: "0" });
		expect(result).toMatchObject({ isError: true, text: expect.stringContaining("Changed by someone else") });
		expect(writes(mock.gtm())).toHaveLength(0);
	});

	it("refuses an empty patch without calling Google", async () => {
		const mock = mockGtm(routes());
		expect((await callTool("update_zone", ZONE_ARGS)).isError).toBe(true);
		expect(mock.gtm()).toHaveLength(0);
	});
});

describe("delete_zone", () => {
	it("without confirm only GETs and previews", async () => {
		const mock = mockGtm(routes());
		const result = await callTool("delete_zone", ZONE_ARGS);
		expect(writes(mock.gtm())).toHaveLength(0);
		expect(result.json()).toMatchObject({
			preview: true,
			wouldDelete: { kind: "zone", zoneId: "4", name: "Checkout" },
		});
	});

	it("with confirm: true sends one DELETE", async () => {
		const mock = mockGtm({ [ZONE]: byMethod({ DELETE: empty }) });
		const result = await callTool("delete_zone", { ...ZONE_ARGS, confirm: true });
		expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "DELETE", path: ZONE, query: {} }]);
		expect(result.json()).toEqual({ deleted: { kind: "zone", id: "4" }, note: UNPUBLISHED_CHANGES_NOTE });
	});
});
