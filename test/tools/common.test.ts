// Rules every GTM read tool shares: IDs are validated before anything is sent, and Google
// errors come back as isError results with the friendly messages.

import { afterEach, describe, expect, it, vi } from "vitest";
import { errors } from "../fixtures/gtm";
import {
	ACCOUNT,
	ACCOUNT_ID,
	CONTAINER,
	CONTAINER_ARGS,
	callTool,
	FAKE_GOOGLE_TOKEN,
	mockGtm,
	reply,
	WORKSPACE,
	WORKSPACE_ARGS,
} from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

interface Case {
	tool: string;
	args: Record<string, string>;
	/** The one API path the tool GETs. */
	path: string;
}

const CASES: Case[] = [
	{ tool: "list_containers", args: { accountId: ACCOUNT_ID }, path: `${ACCOUNT}/containers` },
	{ tool: "get_container_snippet", args: CONTAINER_ARGS, path: `${CONTAINER}:snippet` },
	{ tool: "list_workspaces", args: CONTAINER_ARGS, path: `${CONTAINER}/workspaces` },
	{ tool: "get_workspace_status", args: WORKSPACE_ARGS, path: `${WORKSPACE}/status` },
	{ tool: "list_tags", args: WORKSPACE_ARGS, path: `${WORKSPACE}/tags` },
	{ tool: "get_tag", args: { ...WORKSPACE_ARGS, tagId: "12" }, path: `${WORKSPACE}/tags/12` },
	{ tool: "list_triggers", args: WORKSPACE_ARGS, path: `${WORKSPACE}/triggers` },
	{ tool: "get_trigger", args: { ...WORKSPACE_ARGS, triggerId: "34" }, path: `${WORKSPACE}/triggers/34` },
	{ tool: "list_variables", args: WORKSPACE_ARGS, path: `${WORKSPACE}/variables` },
	{ tool: "get_variable", args: { ...WORKSPACE_ARGS, variableId: "56" }, path: `${WORKSPACE}/variables/56` },
	{ tool: "list_folders", args: WORKSPACE_ARGS, path: `${WORKSPACE}/folders` },
	{ tool: "list_built_in_variables", args: WORKSPACE_ARGS, path: `${WORKSPACE}/built_in_variables` },
	{ tool: "get_live_version", args: CONTAINER_ARGS, path: `${CONTAINER}/versions:live` },
	{ tool: "list_versions", args: CONTAINER_ARGS, path: `${CONTAINER}/version_headers` },
];

/** What a 404 tells the model to check: the IDs in that path, innermost first. */
const CONTAINER_HINT = "Check the container ID, then the account ID.";
const WORKSPACE_HINT = "Check the workspace ID, then the account/container IDs.";
const NOT_FOUND_HINTS: Record<string, string> = {
	list_containers: "Check the account ID.",
	get_container_snippet: CONTAINER_HINT,
	list_workspaces: CONTAINER_HINT,
	get_workspace_status: WORKSPACE_HINT,
	list_tags: WORKSPACE_HINT,
	get_tag: "Check the tag ID, then the account/container/workspace IDs.",
	list_triggers: WORKSPACE_HINT,
	get_trigger: "Check the trigger ID, then the account/container/workspace IDs.",
	list_variables: WORKSPACE_HINT,
	get_variable: "Check the variable ID, then the account/container/workspace IDs.",
	list_folders: WORKSPACE_HINT,
	list_built_in_variables: WORKSPACE_HINT,
	list_versions: CONTAINER_HINT,
};

const BAD_IDS = ["abc", "1/../2", "12?x=1", "", "GTM-ABC1234"];

/** Write tools with the smallest valid arguments: every ID must be checked before any call. */
const WRITE_CASES: Array<{ tool: string; ids: Record<string, string>; rest: Record<string, unknown> }> = [
	{ tool: "create_workspace", ids: CONTAINER_ARGS, rest: { name: "w" } },
	{ tool: "create_tag", ids: WORKSPACE_ARGS, rest: { name: "t", type: "html" } },
	{ tool: "update_tag", ids: { ...WORKSPACE_ARGS, tagId: "12" }, rest: { name: "t" } },
	{ tool: "delete_tag", ids: { ...WORKSPACE_ARGS, tagId: "12" }, rest: { confirm: true } },
	{ tool: "create_trigger", ids: WORKSPACE_ARGS, rest: { name: "t", type: "pageview" } },
	{ tool: "update_trigger", ids: { ...WORKSPACE_ARGS, triggerId: "34" }, rest: { name: "t" } },
	{ tool: "delete_trigger", ids: { ...WORKSPACE_ARGS, triggerId: "34" }, rest: { confirm: true } },
	{ tool: "create_variable", ids: WORKSPACE_ARGS, rest: { name: "v", type: "c" } },
	{ tool: "update_variable", ids: { ...WORKSPACE_ARGS, variableId: "56" }, rest: { name: "v" } },
	{ tool: "delete_variable", ids: { ...WORKSPACE_ARGS, variableId: "56" }, rest: { confirm: true } },
	{ tool: "create_folder", ids: WORKSPACE_ARGS, rest: { name: "f" } },
	{ tool: "move_entities_to_folder", ids: { ...WORKSPACE_ARGS, folderId: "9" }, rest: { tagId: ["12"] } },
	{ tool: "enable_built_in_variables", ids: WORKSPACE_ARGS, rest: { types: ["pageUrl"] } },
	{ tool: "quick_preview_workspace", ids: WORKSPACE_ARGS, rest: {} },
	{ tool: "create_version", ids: WORKSPACE_ARGS, rest: { name: "v" } },
];

describe.each(WRITE_CASES)("$tool", ({ tool, ids, rest }) => {
	it.each(Object.keys(ids))("rejects a non-numeric %s before calling Google", async (key) => {
		const mock = mockGtm();
		for (const bad of BAD_IDS) {
			const result = await callTool(tool, { ...ids, ...rest, [key]: bad });
			expect(result.isError).toBe(true);
			expect(result.text).toContain("must be a numeric ID");
		}
		expect(mock.calls).toHaveLength(0);
	});
});

describe.each(CASES)("$tool", ({ tool, args, path }) => {
	it.each(Object.keys(args))("rejects a non-numeric %s before calling Google", async (key) => {
		const mock = mockGtm();
		for (const bad of BAD_IDS) {
			const result = await callTool(tool, { ...args, [key]: bad });
			expect(result.isError).toBe(true);
			expect(result.text).toContain("must be a numeric ID");
		}
		expect(mock.calls).toHaveLength(0);
	});

	it("rejects missing arguments", async () => {
		const mock = mockGtm();
		const result = await callTool(tool, {});
		expect(result.isError).toBe(true);
		expect(result.text).toContain("Input validation error");
		expect(mock.calls).toHaveLength(0);
	});

	it("maps a 403 to a permission message, without retrying", async () => {
		const mock = mockGtm({ [path]: reply(errors.forbidden403, 403) });
		const result = await callTool(tool, args);
		expect(result).toMatchObject({
			isError: true,
			text: `No permission for ${path}. Check the Google account has access.`,
		});
		expect(mock.gtm()).toHaveLength(1);
		expect(result.text).not.toContain(FAKE_GOOGLE_TOKEN);
	});

	it("maps a 403 for a disabled API to the enable-the-API message", async () => {
		mockGtm({ [path]: reply(errors.apiDisabled403, 403) });
		const result = await callTool(tool, args);
		expect(result.isError).toBe(true);
		expect(result.text).toContain("The Tag Manager API is not enabled");
	});

	if (tool !== "get_live_version") {
		it("maps a 404 to a not-found message", async () => {
			mockGtm({ [path]: reply(errors.notFound404, 404) });
			const result = await callTool(tool, args);
			expect(result).toMatchObject({
				isError: true,
				text: `Not found: ${path}. ${NOT_FOUND_HINTS[tool]}`,
			});
		});
	}
});
