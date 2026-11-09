// create_variable, update_variable, delete_variable: requests sent, Q15, Q12/Q13 on update.

import { afterEach, describe, expect, it, vi } from "vitest";
import { LIST_PAGE_BUDGET } from "../../src/gtm/client";
import type { Variable } from "../../src/gtm/generated";
import { DLV_DEFAULT_VALUE_WARNING, UNPUBLISHED_CHANGES_NOTE } from "../../src/gtm/quirks";
import { dlvVariable, errors } from "../fixtures/gtm";
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

const VARIABLE = `${WORKSPACE}/variables/56`;
const VARIABLE_ARGS = { ...WORKSPACE_ARGS, variableId: "56" };
const { fingerprint: STORED_FINGERPRINT, ...storedBody } = dlvVariable;

function routes() {
	return {
		[VARIABLE]: byMethod({
			GET: () => json(dlvVariable),
			PUT: (call) => json({ ...(JSON.parse(call.body) as Variable), fingerprint: "1731100000097" }),
		}),
	};
}

describe("create_variable", () => {
	it("POSTs {workspace}/variables with exactly the given fields", async () => {
		const mock = mockGtm({
			[`${WORKSPACE}/variables`]: (call) => json({ ...(JSON.parse(call.body) as Variable), variableId: "60" }),
		});
		const result = await callTool("create_variable", {
			...WORKSPACE_ARGS,
			name: "CONST - GA4 ID",
			type: "c",
			parameter: [{ type: "template", key: "value", value: "G-ABC123" }],
			notes: "Measurement ID",
		});
		expect(describeCall(mock.gtm()[0])).toMatchObject({
			method: "POST",
			path: `${WORKSPACE}/variables`,
			query: {},
			body: {
				name: "CONST - GA4 ID",
				type: "c",
				parameter: [{ type: "template", key: "value", value: "G-ABC123" }],
				notes: "Measurement ID",
			},
		});
		expect(result.json()).toMatchObject({ variable: { variableId: "60" }, note: UNPUBLISHED_CHANGES_NOTE });
	});

	it("Q15: an empty integer defaultValue on a DLV is sent as an empty template, with a warning", async () => {
		const mock = mockGtm({ [`${WORKSPACE}/variables`]: (call) => json(JSON.parse(call.body)) });
		const result = await callTool("create_variable", {
			...WORKSPACE_ARGS,
			name: "DLV - value",
			type: "v",
			parameter: [
				{ type: "template", key: "name", value: "ecommerce.value" },
				{ type: "integer", key: "defaultValue", value: "" },
			],
		});
		expect((describeCall(mock.gtm()[0]).body as Variable).parameter).toEqual([
			{ type: "template", key: "name", value: "ecommerce.value" },
			{ type: "template", key: "defaultValue", value: "" },
		]);
		expect(result.json<{ warnings: string[] }>().warnings).toEqual([DLV_DEFAULT_VALUE_WARNING]);
	});
});

describe("update_variable", () => {
	it("Q1/Q2: GET, then PUT of the merged variable with ?fingerprint=", async () => {
		const mock = mockGtm(routes());
		const parameter = [{ type: "template", key: "name", value: "user.id" }];
		await callTool("update_variable", { ...VARIABLE_ARGS, parameter, fingerprint: STORED_FINGERPRINT });
		const calls = mock.gtm().map(describeCall);
		expect(calls.map((c) => [c.method, c.path, c.query])).toEqual([
			["GET", VARIABLE, {}],
			["PUT", VARIABLE, { fingerprint: STORED_FINGERPRINT }],
		]);
		expect(calls[1]?.body).toEqual({ ...storedBody, parameter });
	});

	it("Q12/Q13: a rename keeps notes and folder", async () => {
		const mock = mockGtm(routes());
		await callTool("update_variable", { ...VARIABLE_ARGS, name: "DLV - userId" });
		const body = describeCall(mock.gtm()[1]).body as Variable;
		expect(body).toEqual({ ...storedBody, name: "DLV - userId" });
		expect(body.notes).toBe("From the login push");
		expect(body.parentFolderId).toBe("9");
	});

	it("Q15 applies on update using the stored type", async () => {
		const mock = mockGtm(routes());
		const result = await callTool("update_variable", {
			...VARIABLE_ARGS,
			parameter: [{ type: "integer", key: "defaultValue" }],
		});
		expect((describeCall(mock.gtm()[1]).body as Variable).parameter).toEqual([
			{ type: "template", key: "defaultValue", value: "" },
		]);
		expect(result.json<{ warnings: string[] }>().warnings).toEqual([DLV_DEFAULT_VALUE_WARNING]);
	});

	it("Q2: a stale fingerprint fails with a conflict and sends no PUT", async () => {
		const mock = mockGtm(routes());
		const result = await callTool("update_variable", { ...VARIABLE_ARGS, notes: "", fingerprint: "1" });
		expect(result).toMatchObject({ isError: true, text: expect.stringContaining("It changed since it was read") });
		expect(writes(mock.gtm())).toHaveLength(0);
	});
});

describe("delete_variable", () => {
	/** Tag 12, trigger 34 and variable 60 use {{DLV - user_id}}; tag 13 only mentions it in notes. */
	function usageRoutes(used = true) {
		const ref = used ? "{{DLV - user_id}}" : "{{Other}}";
		return {
			[`${WORKSPACE}/tags`]: pages("tag", [
				[
					{
						tagId: "12",
						name: "GA4 - login",
						parameter: [
							{
								type: "list",
								key: "eventParameters",
								list: [{ type: "map", map: [{ type: "template", key: "value", value: `id=${ref}` }] }],
							},
						],
					},
					{ tagId: "13", name: "Notes only", notes: "uses {{DLV - user_id}} later", parameter: [] },
				],
			]),
			[`${WORKSPACE}/triggers`]: pages("trigger", [
				[
					{
						triggerId: "34",
						name: "CE - login",
						type: "customEvent",
						filter: [{ type: "equals", parameter: [{ type: "template", key: "arg0", value: ref }] }],
					},
				],
			]),
			[`${WORKSPACE}/variables`]: pages("variable", [
				[
					dlvVariable,
					{
						variableId: "60",
						name: "JS - hashed id",
						type: "jsm",
						parameter: [{ type: "template", key: "javascript", value: `function(){return ${ref}}` }],
					},
				],
			]),
		};
	}

	it("Q26 without confirm only reads, and lists what uses {{name}}, saying the delete will fail", async () => {
		const mock = mockGtm({ ...routes(), ...usageRoutes() });
		const result = await callTool("delete_variable", VARIABLE_ARGS);
		expect(writes(mock.gtm())).toHaveLength(0);
		const out = result.json<{ preview: boolean; wouldDelete: Record<string, unknown> }>();
		expect(out).toMatchObject({
			preview: true,
			wouldDelete: {
				kind: "variable",
				variableId: "56",
				name: "DLV - user_id",
				type: "v",
				parentFolderId: "9",
				usedByTags: [{ id: "12", name: "GA4 - login" }],
				usedByTriggers: [{ id: "34", name: "CE - login" }],
				usedByVariables: [{ id: "60", name: "JS - hashed id" }],
			},
		});
		expect(out.wouldDelete.warning).toContain("GTM will refuse to delete this variable while these still use it.");
	});

	it("an unused variable's preview has no references and no warning", async () => {
		mockGtm({ ...routes(), ...usageRoutes(false) });
		const out = (await callTool("delete_variable", VARIABLE_ARGS)).json<{ wouldDelete: Record<string, unknown> }>();
		expect(out.wouldDelete).toEqual({
			kind: "variable",
			variableId: "56",
			name: "DLV - user_id",
			type: "v",
			parentFolderId: "9",
		});
	});

	it("Q26 with confirm: true, GTM's bare 400 becomes an error naming what still uses the variable", async () => {
		const mock = mockGtm({
			[VARIABLE]: byMethod({ GET: () => json(dlvVariable), DELETE: () => json(errors.stillInUse400, 400) }),
			...usageRoutes(),
		});
		const result = await callTool("delete_variable", { ...VARIABLE_ARGS, confirm: true });
		expect(writes(mock.gtm()).map(describeCall)).toMatchObject([{ method: "DELETE", path: VARIABLE }]);
		expect(result.isError).toBe(true);
		expect(result.text).toBe(
			'Nothing was deleted: GTM refuses to delete variable 56 while it is still used by tags 12 "GA4 - login"; triggers 34 "CE - login"; variables 60 "JS - hashed id". First replace or remove its {{name}} in those tags, triggers and variables, or delete them.',
		);
	});

	/** 20 pages of 1 entity each per list: far more than one call may read. */
	function hugeWorkspace() {
		const many = (make: (n: number) => Record<string, unknown>) => Array.from({ length: 20 }, (_, n) => [make(n)]);
		return {
			[`${WORKSPACE}/tags`]: pages(
				"tag",
				many((n) => ({ tagId: `${100 + n}`, name: `Tag ${n}` })),
			),
			[`${WORKSPACE}/triggers`]: pages(
				"trigger",
				many((n) => ({ triggerId: `${200 + n}`, name: `Trigger ${n}` })),
			),
			[`${WORKSPACE}/variables`]: pages(
				"variable",
				many((n) => ({ variableId: `${300 + n}`, name: `Var ${n}` })),
			),
		};
	}

	it("on a huge workspace the reference check stays in the page budget and says it could not check all", async () => {
		const mock = mockGtm({ ...routes(), ...hugeWorkspace() });
		const result = await callTool("delete_variable", VARIABLE_ARGS);
		const lists = mock.gtm().filter((c) => !c.url.includes("/variables/56"));
		expect(lists).toHaveLength(LIST_PAGE_BUDGET);
		expect(mock.gtm().length).toBeLessThan(50);
		expect(result.json()).toMatchObject({
			preview: true,
			wouldDelete: {
				kind: "variable",
				partial: true,
				partialNote: expect.stringContaining("Could not check all of the workspace"),
			},
		});
	});

	it("after a refused DELETE on a huge workspace, the error says the check was incomplete", async () => {
		mockGtm({
			[VARIABLE]: byMethod({ GET: () => json(dlvVariable), DELETE: () => json(errors.stillInUse400, 400) }),
			...hugeWorkspace(),
		});
		const result = await callTool("delete_variable", { ...VARIABLE_ARGS, confirm: true });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("Nothing was deleted: GTM refused to delete variable 56.");
		expect(result.text).toContain("Could not check all of the workspace");
	});

	it("with confirm: true sends one DELETE", async () => {
		const mock = mockGtm({ [VARIABLE]: byMethod({ DELETE: empty }) });
		const result = await callTool("delete_variable", { ...VARIABLE_ARGS, confirm: true });
		expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "DELETE", path: VARIABLE, query: {} }]);
		expect(result.json()).toEqual({ deleted: { kind: "variable", id: "56" }, note: UNPUBLISHED_CHANGES_NOTE });
	});
});
