// The tools/list surface: a snapshot to review in diffs, and the 40 KB budget.
// Goes through the real Worker (OAuthProvider → /mcp) with a minted MCP token.

import { afterEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_TOKEN_URL, googleCodeResponse, mockFetch } from "./helpers/google";
import { login, mcpRequest } from "./helpers/oauth";

afterEach(() => {
	vi.restoreAllMocks();
});

/** Keep the tools/list response under 40 KB. */
const BUDGET_BYTES = 40 * 1024;

interface ListedTool {
	name: string;
	description?: string;
	annotations?: Record<string, unknown>;
	inputSchema: { properties?: Record<string, unknown>; required?: string[] };
}

async function toolsList() {
	mockFetch({ [GOOGLE_TOKEN_URL]: () => googleCodeResponse() });
	const { access_token } = await login();
	const res = await mcpRequest(access_token, "tools/list");
	expect(res.status).toBe(200);
	const raw = await res.text();
	// SSE framing is transport overhead; measure the JSON-RPC message itself.
	const body = res.headers.get("Content-Type")?.includes("text/event-stream")
		? (raw
				.split("\n")
				.filter((l) => l.startsWith("data:"))
				.map((l) => l.slice(5).trim())
				.at(-1) ?? "")
		: raw;
	const tools = (JSON.parse(body) as { result: { tools: ListedTool[] } }).result.tools;
	return { body, tools };
}

describe("tools/list", () => {
	it(`stays under ${BUDGET_BYTES} bytes`, async () => {
		const { body } = await toolsList();
		const bytes = new TextEncoder().encode(body).byteLength;
		expect(bytes).toBeLessThan(BUDGET_BYTES);
	});

	it("matches the snapshot (names, descriptions, annotations, arguments)", async () => {
		const { tools } = await toolsList();
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
		const { tools } = await toolsList();
		for (const t of tools) {
			expect(t.description?.length, t.name).toBeGreaterThan(10);
			expect(t.description?.length, t.name).toBeLessThanOrEqual(200);
			const a = t.annotations ?? {};
			expect(a.readOnlyHint === true || typeof a.destructiveHint === "boolean", t.name).toBe(true);
		}
	});

	it("marks deletes destructive with a confirm argument, and other writes non-destructive", async () => {
		const { tools } = await toolsList();
		const destructive = tools.filter((t) => t.annotations?.destructiveHint === true).map((t) => t.name);
		expect(destructive.sort()).toEqual([
			"delete_container",
			"delete_tag",
			"delete_trigger",
			"delete_variable",
			"delete_workspace",
			"publish_version",
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
		const { tools } = await toolsList();
		const names = tools.map((t) => t.name);
		expect(names.length).toBeGreaterThan(0);
		expect(names.filter((n) => /delete_account/i.test(n))).toEqual([]);
	});
});
