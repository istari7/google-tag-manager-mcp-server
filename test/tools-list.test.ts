// The tools/list surface: the 40 KB budget for the default tool groups (through the real
// Worker: OAuthProvider → /mcp with a minted MCP token and wrangler.jsonc's GTM_TOOL_GROUPS),
// and a snapshot of every tool (GTM_TOOL_GROUPS=all) to review in diffs.
// Which tools each group holds: test/tool-groups.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_TOKEN_URL, googleCodeResponse, mockFetch } from "./helpers/google";
import { login, mcpRequest } from "./helpers/oauth";
import { fakeProps } from "./helpers/props";
import { rawRpc } from "./tools/helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

/** Keep the default groups' tools/list response under 40 KB. */
const BUDGET_BYTES = 40 * 1024;

interface ListedTool {
	name: string;
	description?: string;
	annotations?: Record<string, unknown>;
	inputSchema: { properties?: Record<string, unknown>; required?: string[] };
}

/** The JSON-RPC message of a /mcp response. SSE framing is transport overhead, not counted. */
async function listed(res: Response) {
	expect(res.status).toBe(200);
	const raw = await res.text();
	const body = res.headers.get("Content-Type")?.includes("text/event-stream")
		? (raw
				.split("\n")
				.filter((l) => l.startsWith("data:"))
				.map((l) => l.slice(5).trim())
				.at(-1) ?? "")
		: raw;
	const tools = (JSON.parse(body) as { result: { tools: ListedTool[] } }).result.tools;
	return { body, bytes: new TextEncoder().encode(body).byteLength, tools };
}

/** tools/list as a client sees it after signing in, with the deployed GTM_TOOL_GROUPS. */
async function defaultToolsList() {
	mockFetch({ [GOOGLE_TOKEN_URL]: () => googleCodeResponse() });
	const { access_token } = await login();
	return listed(await mcpRequest(access_token, "tools/list"));
}

/** tools/list with every group on. */
async function allToolsList() {
	return listed(await rawRpc("tools/list", {}, fakeProps(), "all"));
}

describe("tools/list", () => {
	it(`stays under ${BUDGET_BYTES} bytes with the default tool groups`, async () => {
		const { bytes, tools } = await defaultToolsList();
		const all = await allToolsList();
		// Reported, not asserted: GTM_TOOL_GROUPS=all is an operator's informed choice.
		console.info(
			`tools/list: default groups ${tools.length} tools, ${bytes} bytes; all groups ${all.tools.length} tools, ${all.bytes} bytes (budget ${BUDGET_BYTES})`,
		);
		expect(bytes).toBeLessThan(BUDGET_BYTES);
		expect(tools.length).toBeLessThan(all.tools.length);
	});

	it("matches the snapshot (names, descriptions, annotations, arguments)", async () => {
		const { tools } = await allToolsList();
		const surface = tools.map((t) => ({
			name: t.name,
			description: t.description,
			annotations: t.annotations,
			args: Object.keys(t.inputSchema.properties ?? {}),
			required: t.inputSchema.required ?? [],
		}));
		expect(surface).toMatchSnapshot();
	});

	it("gives every tool a short description and a read/write annotation", async () => {
		const { tools } = await allToolsList();
		for (const t of tools) {
			expect(t.description?.length, t.name).toBeGreaterThan(10);
			expect(t.description?.length, t.name).toBeLessThanOrEqual(200);
			const a = t.annotations ?? {};
			expect(a.readOnlyHint === true || typeof a.destructiveHint === "boolean", t.name).toBe(true);
		}
	});

	it("marks deletes destructive with a confirm argument, and other writes non-destructive", async () => {
		const { tools } = await allToolsList();
		const destructive = tools.filter((t) => t.annotations?.destructiveHint === true).map((t) => t.name);
		expect(destructive.sort()).toEqual([
			"delete_client",
			"delete_container",
			"delete_environment",
			"delete_folder",
			"delete_google_tag_config",
			"delete_tag",
			"delete_transformation",
			"delete_trigger",
			"delete_user_permission",
			"delete_variable",
			"delete_workspace",
			"delete_zone",
			"disable_built_in_variables",
			"link_destination",
			"publish_version",
			"reauthorize_environment",
			"set_user_permission",
			"update_account",
			"update_environment",
		]);
		for (const t of tools) {
			const a = t.annotations ?? {};
			if (a.readOnlyHint === true) continue;
			expect(a.readOnlyHint, t.name).toBe(false);
			expect(typeof a.idempotentHint, t.name).toBe("boolean");
			if (destructive.includes(t.name)) {
				expect(Object.keys(t.inputSchema.properties ?? {}), t.name).toContain("confirm");
				expect(t.inputSchema.required ?? [], t.name).not.toContain("confirm");
			}
		}
	});

	it("has no tool that deletes an account (the API has none)", async () => {
		const { tools } = await allToolsList();
		const names = tools.map((t) => t.name);
		expect(names.length).toBeGreaterThan(0);
		expect(names.filter((n) => /delete_account/i.test(n))).toEqual([]);
	});
});
