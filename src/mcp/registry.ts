// The one way tools get registered. Tool files export a ToolGroup; src/mcp/server.ts runs
// every group against a registry bound to one request's McpServer and ToolContext.

import type { CallToolResult, McpServer, StandardSchemaWithJSON, ToolAnnotations } from "@modelcontextprotocol/server";
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
 * The tool body. Arguments are already validated against `input`. Return `ok(...)`,
 * `okEntity(...)` or `okList(...)` from ./result. Anything thrown becomes `fail(error)`.
 */
export type ToolRun<S extends z.ZodObject> = (
	args: z.output<S>,
	ctx: ToolContext,
) => CallToolResult | Promise<CallToolResult>;

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

export function toolRegistry(server: McpServer, ctx: ToolContext): ToolRegistry {
	return {
		add<S extends z.ZodObject>(name: string, spec: ToolSpec<S>, run: ToolRun<S>) {
			// Explicit type arguments: TS can't pick the overload for a generic zod schema.
			const input = sdkSchema(spec.input);
			server.registerTool<StandardSchemaWithJSON, typeof input>(
				name,
				{ description: spec.description, inputSchema: input, annotations: spec.annotations },
				async (args) => {
					try {
						return await run(args, ctx);
					} catch (error) {
						return fail(error);
					}
				},
			);
		},
	};
}
