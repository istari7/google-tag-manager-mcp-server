// Shared setup for tool tests. Tools are called through the real /mcp handler
// (`handleMcp`: agents' createMcpHandler + our McpServer) with fake grant props, so the
// OAuth layer (covered by auth*.test.ts) is skipped but everything after it is real.
// Outbound GTM calls are caught by mockFetch(); an unmatched request fails the test.

import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import type { Props } from "../../src/env";
import { handleMcp } from "../../src/mcp/server";
import { json, mockFetch, type RecordedCall, type Route } from "../helpers/google";
import { mcpResult, ORIGIN } from "../helpers/oauth";
import { fakeProps } from "../helpers/props";

export { json };

export const GTM = "https://tagmanager.googleapis.com/tagmanager/v2";
export const ACCOUNT_ID = "1234567890";
export const CONTAINER_ID = "201";
export const WORKSPACE_ID = "7";
export const ACCOUNT = `accounts/${ACCOUNT_ID}`;
export const CONTAINER = `${ACCOUNT}/containers/${CONTAINER_ID}`;
export const WORKSPACE = `${CONTAINER}/workspaces/${WORKSPACE_ID}`;
export const CONTAINER_ARGS = { accountId: ACCOUNT_ID, containerId: CONTAINER_ID };
export const WORKSPACE_ARGS = { ...CONTAINER_ARGS, workspaceId: WORKSPACE_ID };
export const FAKE_GOOGLE_TOKEN = fakeProps().googleAccessToken;

let nextId = 1;

/** Raw /mcp response for one JSON-RPC call, with GTM_TOOL_GROUPS set to `toolGroups`. */
export function rawRpc(method: string, params: unknown, props: Props, toolGroups: string): Promise<Response> {
	const request = new Request(`${ORIGIN}/mcp`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
		body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
	});
	return handleMcp(request, { ...env, GTM_TOOL_GROUPS: toolGroups }, createExecutionContext(), props);
}

/**
 * One JSON-RPC call to /mcp as an already signed-in user. Every tool group is on, so tool
 * tests don't depend on which groups are default (test/tool-groups.test.ts covers that).
 */
export async function rpc(method: string, params: unknown = {}, props: Props = fakeProps(), toolGroups = "all") {
	const res = await rawRpc(method, params, props, toolGroups);
	expect(res.status).toBe(200);
	return mcpResult(res);
}

/** The MCP protocol revision whose requests carry their own `_meta` envelope (multi round-trip). */
export const MODERN_PROTOCOL = "2026-07-28";

/**
 * One tools/call as a 2026-07-28 client sends it: per-request `_meta` envelope (with these
 * client capabilities) and the MCP-Protocol-Version / Mcp-Method / Mcp-Name headers. Pass
 * `inputResponses` to retry after an input_required result. Returns the JSON-RPC message.
 */
export async function modernToolCall(
	name: string,
	args: Record<string, unknown>,
	options: { capabilities?: Record<string, unknown>; inputResponses?: Record<string, unknown> } = {},
): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
	const params = {
		name,
		arguments: args,
		_meta: {
			"io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL,
			"io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
			"io.modelcontextprotocol/clientCapabilities": options.capabilities ?? {},
		},
		...(options.inputResponses ? { inputResponses: options.inputResponses } : {}),
	};
	const request = new Request(`${ORIGIN}/mcp`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": MODERN_PROTOCOL,
			"Mcp-Method": "tools/call",
			"Mcp-Name": name,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params }),
	});
	const res = await handleMcp(request, { ...env, GTM_TOOL_GROUPS: "all" }, createExecutionContext(), fakeProps());
	expect(res.status).toBe(200);
	return (await mcpResult(res)) as { result?: Record<string, unknown>; error?: unknown };
}

export interface ToolCallResult {
	text: string;
	isError: boolean;
	/** The text parsed as JSON. */
	json<T = Record<string, unknown>>(): T;
}

export async function callTool(
	name: string,
	args: Record<string, unknown> = {},
	props?: Props,
): Promise<ToolCallResult> {
	const { result, error } = await rpc("tools/call", { name, arguments: args }, props);
	expect(error).toBeUndefined();
	const r = result as { content: Array<{ type: string; text: string }>; isError?: boolean };
	const text = r.content.map((c) => c.text).join("");
	return { text, isError: r.isError === true, json: <T>() => JSON.parse(text) as T };
}

/**
 * Mock GTM endpoints. Keys are API paths relative to the v2 base (no query), e.g.
 * `${WORKSPACE}/tags`. Returns the recorded calls.
 */
export function mockGtm(routes: Record<string, Route> = {}, extra: Record<string, Route> = {}) {
	const full: Record<string, Route> = { ...extra };
	for (const [path, route] of Object.entries(routes)) full[`${GTM}/${path}`] = route;
	const mock = mockFetch(full);
	return {
		...mock,
		/** Calls that went to the GTM API. */
		gtm: () => mock.calls.filter((c) => c.url.startsWith(`${GTM}/`)),
	};
}

/** Route that answers every request with the same JSON body and status. */
export const reply =
	(body: unknown, status = 200): Route =>
	() =>
		json(body, status);

/**
 * Route for a paginated list: page 1 without `pageToken`, then page N for `pageToken=pN`.
 * Every page but the last gets `nextPageToken`.
 */
export function pages(key: string, pageItems: unknown[][]): Route {
	return (call) => {
		const token = new URL(call.url).searchParams.get("pageToken");
		const n = token === null ? 0 : Number(token.slice(1)) - 1;
		const items = pageItems[n] ?? [];
		const next = n + 1 < pageItems.length ? { nextPageToken: `p${n + 2}` } : {};
		return json({ [key]: items, ...next });
	};
}

/** Route that dispatches on the HTTP method; any other method fails the test. */
export const byMethod =
	(routes: Partial<Record<"GET" | "POST" | "PUT" | "DELETE", Route>>): Route =>
	(call) => {
		const route = routes[call.method as keyof typeof routes];
		if (!route) throw new Error(`Unexpected ${call.method} ${call.url} in test`);
		return route(call);
	};

/** An empty 200, as Google answers a DELETE or move_entities_to_folder. */
export const empty: Route = () => new Response("", { status: 200 });

/**
 * The API path (relative to the v2 base), query and JSON body of a recorded call. Repeated
 * query keys keep only their last value here; use `queryAll` for those.
 */
export function describeCall(call: RecordedCall | undefined) {
	if (!call) throw new Error("no such call");
	const url = new URL(call.url);
	return {
		method: call.method,
		path: url.pathname.replace(/^\/tagmanager\/v2\//, ""),
		query: Object.fromEntries(url.searchParams),
		body: call.body === "" ? undefined : (JSON.parse(call.body) as unknown),
		auth: call.headers.get("Authorization"),
	};
}

/** Every value of a repeated query key, e.g. `tagId=1&tagId=2` → ["1", "2"]. */
export function queryAll(call: RecordedCall | undefined, key: string): string[] {
	if (!call) throw new Error("no such call");
	return new URL(call.url).searchParams.getAll(key);
}

/** GTM calls that change something (anything but GET). */
export function writes(calls: readonly RecordedCall[]): RecordedCall[] {
	return calls.filter((c) => c.method !== "GET");
}
