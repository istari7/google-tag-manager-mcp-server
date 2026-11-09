// The one way tools get registered. Tool files export a ToolGroup; src/mcp/server.ts runs
// every group against a registry bound to one request's McpServer and ToolContext.

import {
	type CallToolResult,
	CLIENT_CAPABILITIES_META_KEY,
	type InputRequiredResult,
	type McpServer,
	type ServerContext,
	type StandardSchemaWithJSON,
	type ToolAnnotations,
} from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { ToolContext } from "./context";
import { fail } from "./result";

/**
 * Every tool declares whether it reads or writes. Reads set `readOnlyHint: true`;
 * writes set `destructiveHint` (true for deletes, false for creates/updates).
 */
export type Annotations = ToolAnnotations &
	({ readOnlyHint: true } | { readOnlyHint?: false; destructiveHint: boolean; idempotentHint?: boolean });

export interface ToolSpec<S extends z.ZodObject> {
	/** One or two sentences. Details belong in the best-practices resources. */
	description: string;
	/** Zod object for the arguments. Use `NO_INPUT` from src/tools/inputs.ts for none. */
	input: S;
	annotations: Annotations;
}

/**
 * What a tool may know about the MCP request itself (not the GTM user). Only tools that ask the
 * user something (delete_container) need it.
 */
export interface ToolCall {
	/**
	 * The client declared form elicitation on this request, so the tool may return
	 * `inputRequired(...)` (protocol 2026-07-28 multi round-trip: the client asks the user and
	 * retries the call with `inputResponses`). Always false for 2025-era clients: our stateless
	 * transport can't send them server-to-client requests (agents' legacy lane refuses them).
	 */
	readonly canElicit: boolean;
	/** The answers a retried call carries, keyed as the tool asked. Client input: untrusted. */
	readonly inputResponses: Readonly<Record<string, unknown>> | undefined;
}

/** A tool's result: a normal result, or (only when `call.canElicit`) a request for user input. */
export type ToolResult = CallToolResult | InputRequiredResult;

/**
 * The tool body. Arguments are already validated against `input`. Return `ok(...)`,
 * `okEntity(...)` or `okList(...)` from ./result. Anything thrown becomes `fail(error)`.
 */
export type ToolRun<S extends z.ZodObject> = (
	args: z.output<S>,
	ctx: ToolContext,
	call: ToolCall,
) => ToolResult | Promise<ToolResult>;

export interface ToolRegistry {
	add<S extends z.ZodObject>(name: string, spec: ToolSpec<S>, run: ToolRun<S>): void;
}

/** A file's worth of tools, e.g. `export const tagTools: ToolGroup = (tools) => { tools.add(...) }`. */
export type ToolGroup = (tools: ToolRegistry) => void;

type JsonSchemaConvert = StandardSchemaWithJSON["~standard"]["jsonSchema"]["input"];

/** Drop the `$schema` URI: every tool repeats it in tools/list and clients don't need it. */
const withoutSchemaUri =
	(convert: JsonSchemaConvert): JsonSchemaConvert =>
	(options) => {
		const { $schema: _uri, ...rest } = convert(options);
		return rest;
	};

/** The zod schema as the SDK sees it: validation unchanged, JSON Schema without `$schema`. */
function sdkSchema<S extends z.ZodObject>(schema: S): StandardSchemaWithJSON<z.input<S>, z.output<S>> {
	const std = schema["~standard"];
	return {
		"~standard": {
			...std,
			jsonSchema: { input: withoutSchemaUri(std.jsonSchema.input), output: withoutSchemaUri(std.jsonSchema.output) },
		},
	};
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * True when the request's `_meta` envelope (2026-07-28 requests only) declares form
 * elicitation. A bare `elicitation: {}` counts as form, as in the SDK's own capability check.
 */
export function declaresFormElicitation(envelope: unknown): boolean {
	const capabilities = isRecord(envelope) ? envelope[CLIENT_CAPABILITIES_META_KEY] : undefined;
	const elicitation = isRecord(capabilities) ? capabilities.elicitation : undefined;
	if (!isRecord(elicitation)) return false;
	return elicitation.form !== undefined || elicitation.url === undefined;
}

function toolCall(request: ServerContext): ToolCall {
	return {
		canElicit: declaresFormElicitation(request.mcpReq.envelope),
		inputResponses: request.mcpReq.inputResponses,
	};
}

export function toolRegistry(server: McpServer, ctx: ToolContext): ToolRegistry {
	return {
		add<S extends z.ZodObject>(name: string, spec: ToolSpec<S>, run: ToolRun<S>) {
			// Explicit type arguments: TS can't pick the overload for a generic zod schema.
			const input = sdkSchema(spec.input);
			server.registerTool<StandardSchemaWithJSON, typeof input>(
				name,
				{ description: spec.description, inputSchema: input, annotations: spec.annotations },
				async (args, request) => {
					try {
						return await run(args, ctx, toolCall(request));
					} catch (error) {
						return fail(error);
					}
				},
			);
		},
	};
}
