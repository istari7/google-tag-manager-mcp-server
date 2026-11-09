// list_gtag_configs, delete_gtag_config (Q23 leftovers; confirm gating).

import { afterEach, describe, expect, it, vi } from "vitest";
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
const config = {
	gtagConfigId: "27",
	type: "googtag",
	fingerprint: "1",
	path: CONFIG,
	parameter: [{ type: "template", key: "tagId", value: "G-TEST123" }],
};

describe("list_gtag_configs", () => {
	it("GETs {workspace}/gtag_config across pages", async () => {
		const mock = mockGtm({
			[`${WORKSPACE}/gtag_config`]: pages("gtagConfig", [[config], [{ gtagConfigId: "28", type: "awct" }]]),
		});
		const result = await callTool("list_gtag_configs", WORKSPACE_ARGS);
		expect(mock.gtm()).toHaveLength(2);
		expect(result.json()).toEqual({
			gtagConfigs: [
				{ gtagConfigId: "27", type: "googtag", parameter: config.parameter },
				{ gtagConfigId: "28", type: "awct" },
			],
		});
	});
});

describe("delete_gtag_config", () => {
	it.each([{}, { confirm: false }])("without confirm: true (%o) only GETs and previews", async (extra) => {
		const mock = mockGtm({ [CONFIG]: byMethod({ GET: () => json(config) }) });
		const result = await callTool("delete_gtag_config", { ...WORKSPACE_ARGS, gtagConfigId: "27", ...extra });
		expect(writes(mock.gtm())).toHaveLength(0);
		expect(result.json()).toEqual({
			preview: true,
			wouldDelete: { kind: "gtagConfig", gtagConfigId: "27", type: "googtag", parameter: config.parameter },
			message:
				"Nothing was deleted. To delete this Google tag config, get the user's go-ahead, then call delete_gtag_config again with confirm: true.",
		});
	});

	it("with confirm: true sends one DELETE", async () => {
		const mock = mockGtm({ [CONFIG]: byMethod({ DELETE: empty }) });
		const result = await callTool("delete_gtag_config", { ...WORKSPACE_ARGS, gtagConfigId: "27", confirm: true });
		expect(mock.gtm().map(describeCall)).toMatchObject([{ method: "DELETE", path: CONFIG, body: undefined }]);
		expect(result.json()).toEqual({ deleted: { kind: "gtagConfig", id: "27" }, note: UNPUBLISHED_CHANGES_NOTE });
	});
});
