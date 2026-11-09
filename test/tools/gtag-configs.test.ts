// Google tag configs: list/get/create/update/delete_google_tag_config(s) (Q23 leftovers;
// trimmed rows; Q1/Q2/Q7 on update; confirm gating).

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GtagConfig } from "../../src/gtm/generated";
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

const CONFIG = `${WORKSPACE}/gtag_config/27`;
const CONFIG_ARGS = { ...WORKSPACE_ARGS, gtagConfigId: "27" };
const parameter = [
	{ type: "template", key: "tagId", value: "G-TEST123" },
	{ type: "boolean", key: "send_page_view", value: "true" },
	{ type: "list", key: "ogt_auto_events", list: [{ type: "template", value: "scroll" }] },
];
const config = { gtagConfigId: "27", type: "googtag", fingerprint: "1", path: CONFIG, parameter };
const { fingerprint: STORED_FINGERPRINT, ...storedBody } = config;
const ROW = { gtagConfigId: "27", type: "googtag", tagId: "G-TEST123", parameters: 3 };

function routes() {
	return {
		[CONFIG]: byMethod({
			GET: () => json(config),
			PUT: (call) => json({ ...(JSON.parse(call.body) as GtagConfig), fingerprint: "2" }),
		}),
	};
}

describe("list_google_tag_configs", () => {
	it("GETs {workspace}/gtag_config across pages; rows are trimmed to type and tag ID", async () => {
		const mock = mockGtm({
			[`${WORKSPACE}/gtag_config`]: pages("gtagConfig", [[config], [{ gtagConfigId: "28", type: "ogt_1p_data_v2" }]]),
		});
		const result = await callTool("list_google_tag_configs", WORKSPACE_ARGS);
		expect(mock.gtm()).toHaveLength(2);
		expect(result.json()).toEqual({ gtagConfigs: [ROW, { gtagConfigId: "28", type: "ogt_1p_data_v2" }] });
	});
});

describe("get_google_tag_config", () => {
	it("GETs the config and returns it whole, fingerprint included", async () => {
		const mock = mockGtm(routes());
		const result = await callTool("get_google_tag_config", CONFIG_ARGS);
		expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "GET", path: CONFIG }]);
		expect(result.json()).toEqual(config);
	});
});

describe("create_google_tag_config", () => {
	it("POSTs {workspace}/gtag_config with exactly type and parameter", async () => {
		const mock = mockGtm({
			[`${WORKSPACE}/gtag_config`]: (call) =>
				json({ ...(JSON.parse(call.body) as GtagConfig), gtagConfigId: "30", fingerprint: "9" }),
		});
		const result = await callTool("create_google_tag_config", {
			...WORKSPACE_ARGS,
			type: "googtag",
			parameter: [parameter[0]],
		});
		expect(describeCall(mock.gtm()[0])).toMatchObject({
			method: "POST",
			path: `${WORKSPACE}/gtag_config`,
			query: {},
			body: { type: "googtag", parameter: [parameter[0]] },
		});
		expect(result.json()).toEqual({
			gtagConfig: { gtagConfigId: "30", type: "googtag", tagId: "G-TEST123", parameters: 1, fingerprint: "9" },
			note: UNPUBLISHED_CHANGES_NOTE,
		});
	});
});

describe("update_google_tag_config", () => {
	it("Q1/Q2: GET, then PUT of the whole merged config with ?fingerprint=", async () => {
		const mock = mockGtm(routes());
		const result = await callTool("update_google_tag_config", {
			...CONFIG_ARGS,
			type: "gaawc",
			fingerprint: STORED_FINGERPRINT,
		});
		const calls = mock.gtm().map(describeCall);
		expect(calls.map((c) => [c.method, c.path, c.query])).toEqual([
			["GET", CONFIG, {}],
			["PUT", CONFIG, { fingerprint: STORED_FINGERPRINT }],
		]);
		expect(calls[1]?.body).toEqual({ ...storedBody, type: "gaawc" });
		expect(result.json()).toEqual({
			gtagConfig: { ...ROW, type: "gaawc", fingerprint: "2" },
			note: UNPUBLISHED_CHANGES_NOTE,
		});
	});

	it("Q7: parameter: [] clears the parameters", async () => {
		const mock = mockGtm(routes());
		await callTool("update_google_tag_config", { ...CONFIG_ARGS, parameter: [] });
		expect(describeCall(mock.gtm()[1]).body).toEqual({ ...storedBody, parameter: [] });
	});

	it("Q2: a stale fingerprint fails with a conflict and sends no PUT", async () => {
		const mock = mockGtm(routes());
		const result = await callTool("update_google_tag_config", { ...CONFIG_ARGS, type: "x", fingerprint: "0" });
		expect(result).toMatchObject({ isError: true, text: expect.stringContaining("Changed by someone else") });
		expect(writes(mock.gtm())).toHaveLength(0);
	});

	it("refuses an empty patch without calling Google", async () => {
		const mock = mockGtm(routes());
		const result = await callTool("update_google_tag_config", CONFIG_ARGS);
		expect(result.isError).toBe(true);
		expect(mock.gtm()).toHaveLength(0);
	});
});

describe("delete_google_tag_config", () => {
	it.each([{}, { confirm: false }])("without confirm: true (%o) only GETs and previews", async (extra) => {
		const mock = mockGtm({ [CONFIG]: byMethod({ GET: () => json(config) }) });
		const result = await callTool("delete_google_tag_config", { ...CONFIG_ARGS, ...extra });
		expect(writes(mock.gtm())).toHaveLength(0);
		expect(result.json()).toEqual({
			preview: true,
			wouldDelete: { kind: "gtagConfig", ...ROW },
			message:
				"Nothing was deleted. To delete this Google tag config, get the user's go-ahead, then call delete_google_tag_config again with confirm: true.",
		});
	});

	it("with confirm: true sends one DELETE", async () => {
		const mock = mockGtm({ [CONFIG]: byMethod({ DELETE: empty }) });
		const result = await callTool("delete_google_tag_config", { ...CONFIG_ARGS, confirm: true });
		expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "DELETE", path: CONFIG, body: undefined }]);
		expect(result.json()).toEqual({ deleted: { kind: "gtagConfig", id: "27" }, note: UNPUBLISHED_CHANGES_NOTE });
	});
});
