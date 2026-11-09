// Confirm gating (CLAUDE.md): a tool that deletes something, or changes the live site or
// account access, does nothing without `confirm: true`. It returns a preview of what would
// happen instead, and only the confirmed call writes. Every gated tool goes through
// confirmGate(), so the two paths can't mix: `preview` never runs when confirmed, `apply`
// never runs when not. Give the input a `confirm: confirmInput("…")` field (./inputs.ts).

import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ToolResult } from "../mcp/registry";
import { compact, ok } from "../mcp/result";
import { okWrite } from "./write";

type Result<R> = R | Promise<R>;

export interface ConfirmGateOptions<R extends ToolResult = CallToolResult> {
	confirm: boolean | undefined;
	/**
	 * Without `confirm: true`: read-only work that describes the change. Usually returns
	 * okPreview(...); may return fail(...) when the change can't be made at all.
	 */
	preview: () => Result<CallToolResult>;
	/**
	 * With `confirm: true`: make the change and return the result. Only delete_container may
	 * return inputRequired(...) here, to have the client ask the user first.
	 */
	apply: () => Result<R>;
}

export async function confirmGate<R extends ToolResult = CallToolResult>(
	options: ConfirmGateOptions<R>,
): Promise<CallToolResult | R> {
	return options.confirm === true ? options.apply() : options.preview();
}

/**
 * The preview a gated tool returns: `{ preview: true, ...fields, message }`. The message
 * says nothing was changed and how to go ahead (the tool name, `confirm: true`, and any
 * other argument the confirmed call needs).
 */
export function okPreview(fields: Record<string, unknown>, message: string): CallToolResult {
	return ok({ preview: true, ...fields, message });
}

export interface DeleteOptions<T> {
	confirm: boolean | undefined;
	/** The tool's own name, for the preview's "call … again" hint, e.g. "delete_google_tag_config". */
	toolName: string;
	/** Entity kind as describeEntity (./summaries.ts) names it, e.g. "tag", "gtagConfig". */
	kind: string;
	/** How the preview message names the entity. Defaults to `kind`. */
	label?: string;
	id: string;
	/** Reads the entity for the preview. Never called when confirmed. */
	get: () => Promise<T>;
	/** The preview row (list_* row shape). */
	summarize: (entity: T) => Record<string, unknown>;
	/** Extra read-only facts for the preview, e.g. which tags use a trigger. */
	related?: (entity: T) => Promise<Record<string, unknown>>;
	remove: () => Promise<void>;
	/** Replaces UNPUBLISHED_CHANGES_NOTE after the delete, for deletes that are not workspace edits. */
	note?: string;
}

/**
 * A confirm-gated delete. Without `confirm: true`: read the entity and describe what would be
 * deleted. With it: DELETE, and say the deletion is not live until a version is published (Q9).
 */
export function deleteWithConfirm<T>(options: DeleteOptions<T>): Promise<CallToolResult> {
	const { kind, id } = options;
	return confirmGate({
		confirm: options.confirm,
		preview: async () => {
			const entity = await options.get();
			const related = options.related ? await options.related(entity) : {};
			return okPreview(
				{ wouldDelete: compact({ kind, ...options.summarize(entity), ...related }) },
				`Nothing was deleted. To delete this ${options.label ?? kind}, get the user's go-ahead, then call ${options.toolName} again with confirm: true.`,
			);
		},
		apply: async () => {
			await options.remove();
			return okWrite({ deleted: { kind, id } }, options.note === undefined ? {} : { note: options.note });
		},
	});
}
