// The read and delete tools every workspace entity has (list_*, get_*, delete_*), built from
// one description of the entity. Create and update stay hand-written in each entity's file:
// that is where the entity's fields and its quirk fixes (GTM_API_QUIRKS.md) live.
//
//   const tag = workspaceEntity({
//     kind: "tag",
//     ids: workspaceInput.extend({ tagId: gtmId("Tag ID") }),
//     id: (ids) => ids.tagId,
//     path: tagPath,
//     api: accounts.containers.workspaces.tags,
//     items: (page) => page.tag,
//     row: tagRow,
//   });
//   addListTool(tools, tag, { name: "list_tags", key: "tags", description: "…" });
//   addGetTool(tools, tag, { name: "get_tag", description: "…" });
//   addDeleteTool(tools, tag, { name: "delete_tag", description: "…" });
//
// Tool names are given explicitly (never derived from `kind`), and each tool is added where
// it is called, so tools/list order stays under the entity file's control.

import type { CallToolResult } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { GtmClient } from "../gtm/client";
import { workspacePath } from "../gtm/paths";
import type { ToolContext } from "../mcp/context";
import type { ToolRegistry } from "../mcp/registry";
import { okEntity, okList } from "../mcp/result";
import { deleteWithConfirm } from "./confirm";
import { confirmInput, workspaceInput } from "./inputs";

/** The generated calls a workspace entity needs, e.g. `accounts.containers.workspaces.tags`. */
export interface WorkspaceEntityApi<T, P> {
	list(gtm: GtmClient, params: { parent: string; pageToken?: string }): Promise<P>;
	get(gtm: GtmClient, params: { path: string }): Promise<T>;
	delete(gtm: GtmClient, params: { path: string }): Promise<void>;
}

export interface WorkspaceEntity<S extends z.ZodObject, T, P extends { nextPageToken?: string }> {
	/** Entity kind as describeEntity (./summaries.ts) names it, e.g. "tag", "gtagConfig". */
	kind: string;
	/** How delete previews name it, when `kind` reads badly, e.g. "Google tag config". */
	label?: string;
	/** The workspace IDs plus the entity's own ID: `workspaceInput.extend({ tagId: gtmId("Tag ID") })`. */
	ids: S;
	/** The entity's own ID, e.g. `(ids) => ids.tagId`. */
	id: (ids: z.output<S>) => string;
	/** Its API path, from src/gtm/paths.ts, e.g. tagPath. */
	path: (ids: z.output<S>) => string;
	api: WorkspaceEntityApi<T, P>;
	/** The entities on one list page, e.g. `(page) => page.tag`. */
	items: (page: P) => T[] | undefined;
	/** One list_* row, also used as the delete preview. */
	row: (entity: T) => Record<string, unknown>;
}

/** Identity function that lets TypeScript infer the entity's types from the object literal. */
export function workspaceEntity<S extends z.ZodObject, T, P extends { nextPageToken?: string }>(
	entity: WorkspaceEntity<S, T, P>,
): WorkspaceEntity<S, T, P> {
	return entity;
}

interface ToolText {
	name: string;
	description: string;
}

/** list_*: every page (gtm.listAll), one `row` per entity under `key`. */
export function addListTool<S extends z.ZodObject, T, P extends { nextPageToken?: string }>(
	tools: ToolRegistry,
	entity: WorkspaceEntity<S, T, P>,
	{ name, description, key }: ToolText & { key: string },
): void {
	tools.add(name, { description, input: workspaceInput, annotations: { readOnlyHint: true } }, async (ids, { gtm }) => {
		const parent = workspacePath(ids);
		const list = await gtm.listAll(
			(pageToken) => entity.api.list(gtm, { parent, pageToken }),
			(page) => entity.items(page),
		);
		return okList(key, list, entity.row);
	});
}

/** get_*: the whole entity, fingerprint included (updates need it, Q2). */
export function addGetTool<S extends z.ZodObject, T, P extends { nextPageToken?: string }>(
	tools: ToolRegistry,
	entity: WorkspaceEntity<S, T, P>,
	{ name, description }: ToolText,
): void {
	tools.add(name, { description, input: entity.ids, annotations: { readOnlyHint: true } }, async (ids, { gtm }) =>
		okEntity(await entity.api.get(gtm, { path: entity.path(ids) })),
	);
}

export interface DeleteToolText<S extends z.ZodObject, T> extends ToolText {
	/** Extra read-only facts for the preview, e.g. which tags use a trigger. */
	related?: (ids: z.output<S>, ctx: ToolContext, entity: T) => Promise<Record<string, unknown>>;
}

/** delete_*: confirm-gated (deleteWithConfirm in ./confirm.ts). */
export function addDeleteTool<S extends z.ZodObject, T, P extends { nextPageToken?: string }>(
	tools: ToolRegistry,
	entity: WorkspaceEntity<S, T, P>,
	{ name, description, related }: DeleteToolText<S, T>,
): void {
	tools.add(
		name,
		{
			description,
			input: entity.ids.extend({ confirm: confirmInput("delete") }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async (args, ctx): Promise<CallToolResult> => {
			// The ID fields alone, typed (zod drops `confirm`). They carry only refinements, so
			// parsing them again changes nothing.
			const ids = entity.ids.parse(args);
			const path = entity.path(ids);
			return deleteWithConfirm<T>({
				confirm: args.confirm === true,
				toolName: name,
				kind: entity.kind,
				label: entity.label,
				id: entity.id(ids),
				get: () => entity.api.get(ctx.gtm, { path }),
				summarize: entity.row,
				related: related && ((found) => related(ids, ctx, found)),
				remove: () => entity.api.delete(ctx.gtm, { path }),
			});
		},
	);
}
