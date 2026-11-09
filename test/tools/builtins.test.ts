// enable_built_in_variables: types checked against the generated enum, sent as repeated
// `type` query parameters.

import { afterEach, describe, expect, it, vi } from "vitest";
import { UNPUBLISHED_CHANGES_NOTE } from "../../src/gtm/quirks";
import { BUILT_IN_TYPES } from "../../src/tools/builtins";
import { callTool, describeCall, json, mockGtm, queryAll, WORKSPACE, WORKSPACE_ARGS } from "./helpers";

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
