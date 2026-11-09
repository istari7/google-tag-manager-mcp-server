// create_variable, update_variable, delete_variable: requests sent, Q15, Q12/Q13 on update.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Variable } from "../../src/gtm/generated";
import { DLV_DEFAULT_VALUE_WARNING, UNPUBLISHED_CHANGES_NOTE } from "../../src/gtm/quirks";
import { dlvVariable } from "../fixtures/gtm";
import { byMethod, callTool, describeCall, empty, json, mockGtm, WORKSPACE, WORKSPACE_ARGS, writes } from "./helpers";

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
		expect(result).toMatchObject({ isError: true, text: expect.stringContaining("Changed by someone else") });
		expect(writes(mock.gtm())).toHaveLength(0);
	});
});

describe("delete_variable", () => {
	it("without confirm only GETs and previews", async () => {
		const mock = mockGtm(routes());
		const result = await callTool("delete_variable", VARIABLE_ARGS);
		expect(writes(mock.gtm())).toHaveLength(0);
		expect(result.json()).toMatchObject({
			preview: true,
			wouldDelete: { kind: "variable", variableId: "56", name: "DLV - user_id", type: "v", parentFolderId: "9" },
		});
	});

	it("with confirm: true sends one DELETE", async () => {
		const mock = mockGtm({ [VARIABLE]: byMethod({ DELETE: empty }) });
		const result = await callTool("delete_variable", { ...VARIABLE_ARGS, confirm: true });
		expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "DELETE", path: VARIABLE, query: {} }]);
		expect(result.json()).toEqual({ deleted: { kind: "variable", id: "56" }, note: UNPUBLISHED_CHANGES_NOTE });
	});
});
