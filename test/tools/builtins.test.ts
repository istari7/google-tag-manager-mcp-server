// enable_built_in_variables / disable_built_in_variables: types checked against the generated
// enum, sent as repeated `type` query parameters.

import { afterEach, describe, expect, it, vi } from "vitest";
import { UNPUBLISHED_CHANGES_NOTE } from "../../src/gtm/quirks";
import { BUILT_IN_TYPES } from "../../src/tools/builtins";
import {
	byMethod,
	callTool,
	describeCall,
	empty,
	json,
	mockGtm,
	queryAll,
	WORKSPACE,
	WORKSPACE_ARGS,
	writes,
} from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("enable_built_in_variables", () => {
	it("POSTs {workspace}/built_in_variables?type=…&type=… with no body, de-duplicating types", async () => {
		const mock = mockGtm({
			[`${WORKSPACE}/built_in_variables`]: () =>
				json({
					builtInVariable: [
						{ type: "clickUrl", name: "Click URL", path: "x", workspaceId: "7" },
						{ type: "clickText", name: "Click Text" },
					],
				}),
		});
		const result = await callTool("enable_built_in_variables", {
			...WORKSPACE_ARGS,
			types: ["clickUrl", "clickText", "clickUrl"],
		});
		const [call] = mock.gtm();
		expect(mock.gtm()).toHaveLength(1);
		expect(describeCall(call)).toMatchObject({
			method: "POST",
			path: `${WORKSPACE}/built_in_variables`,
			body: undefined,
		});
		expect(queryAll(call, "type")).toEqual(["clickUrl", "clickText"]);
		expect(result.json()).toEqual({
			enabled: [
				{ type: "clickUrl", name: "Click URL" },
				{ type: "clickText", name: "Click Text" },
			],
			note: UNPUBLISHED_CHANGES_NOTE,
		});
	});

	it("reports types Google did not return as alreadyEnabled, keeping the not-live note", async () => {
		mockGtm({
			[`${WORKSPACE}/built_in_variables`]: () => json({ builtInVariable: [{ type: "clickUrl", name: "Click URL" }] }),
		});
		const result = await callTool("enable_built_in_variables", {
			...WORKSPACE_ARGS,
			types: ["pageUrl", "clickUrl", "pagePath"],
		});
		expect(result.json()).toEqual({
			enabled: [{ type: "clickUrl", name: "Click URL" }],
			alreadyEnabled: ["pageUrl", "pagePath"],
			note: UNPUBLISHED_CHANGES_NOTE,
		});
	});

	it("says nothing changed (and drops the not-live note) when all types were already enabled", async () => {
		const mock = mockGtm({ [`${WORKSPACE}/built_in_variables`]: () => json({}) });
		const result = await callTool("enable_built_in_variables", { ...WORKSPACE_ARGS, types: ["pageUrl", "pagePath"] });
		expect(mock.gtm()).toHaveLength(1);
		expect(result.isError).toBe(false);
		// Empty lists are compacted away, so there is no `enabled` key.
		expect(result.json()).toEqual({
			alreadyEnabled: ["pageUrl", "pagePath"],
			note: "Nothing changed: all requested built-ins were already enabled.",
		});
	});

	it("rejects an unknown type with close matches, before calling Google", async () => {
		const mock = mockGtm();
		const result = await callTool("enable_built_in_variables", { ...WORKSPACE_ARGS, types: ["pageURL", "clickurl"] });
		expect(result.isError).toBe(true);
		expect(result.text).toContain('Unknown built-in variable type "pageURL". Did you mean: pageUrl?');
		expect(result.text).toContain('"clickurl". Did you mean: clickUrl?');
		expect(mock.calls).toHaveLength(0);
	});

	it("rejects an empty list", async () => {
		const mock = mockGtm();
		expect((await callTool("enable_built_in_variables", { ...WORKSPACE_ARGS, types: [] })).isError).toBe(true);
		expect(mock.calls).toHaveLength(0);
	});

	it("knows every generated type except the unspecified placeholder", () => {
		expect(BUILT_IN_TYPES).toHaveLength(116);
		expect(BUILT_IN_TYPES).not.toContain("builtInVariableTypeUnspecified");
		expect(new Set(BUILT_IN_TYPES).size).toBe(BUILT_IN_TYPES.length);
	});
});

describe("disable_built_in_variables", () => {
	const BUILT_INS = `${WORKSPACE}/built_in_variables`;
	const listed = () =>
		json({
			builtInVariable: [
				{ type: "pageUrl", name: "Page URL" },
				{ type: "clickUrl", name: "Click URL" },
			],
		});

	it("without confirm: true lists what is enabled and previews, changing nothing", async () => {
		const mock = mockGtm({ [BUILT_INS]: byMethod({ GET: listed }) });
		const result = await callTool("disable_built_in_variables", { ...WORKSPACE_ARGS, types: ["clickUrl", "formId"] });
		expect(writes(mock.gtm())).toHaveLength(0);
		expect(result.json()).toEqual({
			preview: true,
			wouldDisable: [{ type: "clickUrl", name: "Click URL" }],
			notEnabled: ["formId"],
			message:
				"Nothing was changed. Check nothing still uses these variables, get the user's go-ahead, then call disable_built_in_variables again with confirm: true.",
		});
	});

	it("with confirm: true DELETEs {workspace}/built_in_variables?type=... for the enabled ones only", async () => {
		const mock = mockGtm({ [BUILT_INS]: byMethod({ GET: listed, DELETE: empty }) });
		const result = await callTool("disable_built_in_variables", {
			...WORKSPACE_ARGS,
			types: ["clickUrl", "pageUrl", "formId"],
			confirm: true,
		});
		const del = writes(mock.gtm());
		expect(del.map(describeCall)).toMatchObject([{ method: "DELETE", path: BUILT_INS, body: undefined }]);
		expect(queryAll(del[0], "type")).toEqual(["clickUrl", "pageUrl"]);
		expect(result.json()).toEqual({
			disabled: [
				{ type: "clickUrl", name: "Click URL" },
				{ type: "pageUrl", name: "Page URL" },
			],
			notEnabled: ["formId"],
			note: UNPUBLISHED_CHANGES_NOTE,
		});
	});

	it("does nothing when none of the types is enabled", async () => {
		const mock = mockGtm({ [BUILT_INS]: byMethod({ GET: listed }) });
		const result = await callTool("disable_built_in_variables", {
			...WORKSPACE_ARGS,
			types: ["formId"],
			confirm: true,
		});
		expect(writes(mock.gtm())).toHaveLength(0);
		expect(result.json()).toEqual({
			notEnabled: ["formId"],
			message: "Nothing to disable: none of these built-ins is enabled.",
		});
	});
});
