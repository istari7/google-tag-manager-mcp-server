// The MCP server: one stateless McpServer per /mcp request.
//
// ── Adding tools ──────────────────────────────────────────────────────────────────────────
// 1. Put them in a tool-group file, e.g. src/tools/tags.ts, which exports
//      export const tagTools: ToolGroup = (tools) => {
//        tools.add("delete_tag", { description, input, annotations }, async (args, ctx) => ...);
//      };
//    A file may hold reads and writes; add new tools to the existing group for that entity.
//    A new group needs one line in TOOL_GROUPS (src/tools/index.ts).
// 2. `input` is a zod object. Build it from src/tools/inputs.ts (`workspaceInput.extend({
//    tagId: gtmId("Tag ID") })`) so IDs stay numeric strings. Use NO_INPUT for none.
// 3. `annotations` must say `readOnlyHint: true` (reads) or give `destructiveHint`
//    (true for deletes). The type enforces it.
// 4. The body gets validated args and a ToolContext (src/mcp/context.ts): `ctx.gtm` is the
//    GTM client for the signed-in user. Call the generated wrappers
//    (`accounts.containers.workspaces.tags.update(ctx.gtm, …)` in src/gtm/generated.ts), the
//    get-merge-put helpers in src/gtm/merge.ts for updates (Q1/Q2), and src/gtm/quirks.ts.
//    Build paths with src/gtm/paths.ts. Use `ctx.gtm.listAll()` for every list.
// 5. Return ok() / okEntity() / okList() / fail() from src/mcp/result.ts. Throwing is fine:
//    the registry turns any error into fail(error) with a model-friendly message.
// 6. Writes append UNPUBLISHED_CHANGES_NOTE (src/gtm/quirks.ts, Q9). Deletes take
//    `confirm: true` and return a preview without it.
//    Never add a tool that publishes a version or deletes a container or account: the owner
//    has ruled it out, and src/gtm/client.ts refuses those requests anyway.
// 7. Tests: test/tools/<group>.test.ts with the helpers in test/tools/helpers.ts (assert the
//    outgoing request). Then `pnpm test -u` for the tools/list snapshot, and keep it < 40 KB.
// ──────────────────────────────────────────────────────────────────────────────────────────

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp";
import type { Env, Props } from "../env";
import { registerBestPractices } from "../resources/best-practices";
import { TOOL_GROUPS } from "../tools";
import { createToolContext, type ToolContext } from "./context";
import { toolRegistry } from "./registry";

export const SERVER_INFO = { name: "gtm-mcp", version: "0.0.1" } as const;

export function buildServer(ctx: ToolContext): McpServer {
	const server = new McpServer(SERVER_INFO);
	const tools = toolRegistry(server, ctx);
	for (const group of TOOL_GROUPS) group(tools);
	registerBestPractices(server);
	return server;
}

/** Serve one /mcp request for an already-authenticated user. Tests call this directly. */
export function handleMcp(request: Request, env: Env, ctx: ExecutionContext, props: Props): Promise<Response> {
	return createMcpHandler(() => buildServer(createToolContext(props, env)), { route: "/mcp" })(request, env, ctx);
}

/** Protected by OAuthProvider: only reached with a valid MCP access token. ctx.props is decrypted Props. */
export const mcpApiHandler = {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return handleMcp(request, env, ctx, ctx.props as Props);
	},
};
