// The MCP server: one stateless McpServer per /mcp request.
//
// ── Adding tools ──────────────────────────────────────────────────────────────────────────
// 1. Put them in a tool-group file, e.g. src/tools/tags.ts, which exports
//      export const tagTools: ToolGroup = (tools) => {
//        tools.add("delete_tag", { description, input, annotations }, async (args, ctx) => ...);
//      };
//    A file may hold reads and writes; add new tools to the existing group for that entity.
//    A new file needs one line in TOOL_MODULES (src/tools/index.ts), tagged with its
//    GTM_TOOL_GROUPS group (names in src/tools/groups.ts). For a workspace entity,
//    list_* / get_* / delete_* come from src/tools/entity.ts (see tags.ts); write create and
//    update by hand, after reading GTM_API_QUIRKS.md.
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
// 6. Writes append UNPUBLISHED_CHANGES_NOTE (src/gtm/quirks.ts, Q9) via okWrite
//    (src/tools/write.ts). Deletes, and anything that takes effect at once (publishing,
//    account settings, user access), take `confirm: true` and return a preview without it:
//    use confirmGate / okPreview / deleteWithConfirm from src/tools/confirm.ts.
//    delete_container also wants the container's public ID typed back.
// 7. Tests: test/tools/<group>.test.ts with the helpers in test/tools/helpers.ts (assert the
//    outgoing request). Then `pnpm test -u` for the tools/list snapshot, and keep the default
//    groups' tools/list < 40 KB (`pnpm tools-report` shows the bytes per group).
// ──────────────────────────────────────────────────────────────────────────────────────────

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp";
import { version } from "../../package.json";
import type { Env, Props } from "../env";
import { registerBestPractices } from "../resources/best-practices";
import { registerSkillResources } from "../resources/skills";
import { SERVER_INSTRUCTIONS } from "../skills/instructions";
import { registerSkillPrompts } from "../skills/prompts";
import { toolModulesFor } from "../tools";
import { parseToolGroups, type ToolGroupSelection, ToolGroupsError } from "../tools/groups";
import { createToolContext, type ToolContext } from "./context";
import { toolRegistry } from "./registry";

/** The version is package.json's (bundled at build time: wrangler's esbuild inlines just that field). */
export const SERVER_INFO = { name: "gtm-mcp", version } as const;

/** `groups` defaults to GTM_TOOL_GROUPS; throws ToolGroupsError if that is invalid. */
export function buildServer(
	ctx: ToolContext,
	groups: ToolGroupSelection = parseToolGroups(ctx.env.GTM_TOOL_GROUPS),
): McpServer {
	const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
	const tools = toolRegistry(server, ctx);
	for (const register of toolModulesFor(groups)) register(tools);
	registerBestPractices(server);
	// Skills: skills/<name>/SKILL.md → gtm://skills/<name> + prompt <name> (pnpm gen:skills).
	registerSkillResources(server);
	registerSkillPrompts(server, ctx);
	return server;
}

/** Serve one /mcp request for an already-authenticated user. Tests call this directly. */
export async function handleMcp(request: Request, env: Env, ctx: ExecutionContext, props: Props): Promise<Response> {
	let groups: ToolGroupSelection;
	try {
		groups = parseToolGroups(env.GTM_TOOL_GROUPS);
	} catch (error) {
		if (!(error instanceof ToolGroupsError)) throw error;
		// A deploy-time mistake: fail every /mcp request loudly rather than serve a surprise
		// tool set. /setup shows the same message, which echoes only name-shaped input.
		console.error("mcp: invalid GTM_TOOL_GROUPS");
		return Response.json(
			{ jsonrpc: "2.0", id: null, error: { code: -32603, message: error.message } },
			{ status: 500 },
		);
	}
	const handler = createMcpHandler(() => buildServer(createToolContext(props, env), groups), { route: "/mcp" });
	return handler(request, env, ctx);
}

/** Protected by OAuthProvider: only reached with a valid MCP access token. ctx.props is decrypted Props. */
export const mcpApiHandler = {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return handleMcp(request, env, ctx, ctx.props as Props);
	},
};
