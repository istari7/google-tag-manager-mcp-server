// Helpers shared by the write tools: the result shape (entity + quirk warnings + the Q9
// note) and the confirm-gated delete (without `confirm: true`, preview only).

import type { CallToolResult } from "@modelcontextprotocol/server";
import { UNPUBLISHED_CHANGES_NOTE } from "../gtm/quirks";
import { compact, ok } from "../mcp/result";

export interface WriteResultOptions {
	/** Things a quirk fix changed in the caller's input (quirks.ts). Omitted when empty. */
	warnings?: readonly string[];
	/** Defaults to UNPUBLISHED_CHANGES_NOTE (Q9). */
	note?: string;
}

/** A successful write: the trimmed result fields, any warnings, then the note. */
export function okWrite(fields: Record<string, unknown>, options: WriteResultOptions = {}): CallToolResult {
	const warnings = options.warnings ?? [];
	return ok({
		...compact(fields),
		...(warnings.length > 0 ? { warnings } : {}),
		note: options.note ?? UNPUBLISHED_CHANGES_NOTE,
	});
}

/** True when every value is undefined: an update with nothing to change. */
export function isEmptyPatch(fields: Record<string, unknown>): boolean {
	return Object.values(fields).every((v) => v === undefined);
}

export interface DeleteOptions<T> {
	confirm: boolean | undefined;
	/** "tag", "trigger" or "variable". */
	kind: string;
	id: string;
	/** Reads the entity for the preview. Never called when confirmed. */
	get: () => Promise<T>;
	/** The preview row (list_* row shape). */
	summarize: (entity: T) => Record<string, unknown>;
	/** Extra read-only facts for the preview, e.g. which tags use a trigger. */
	related?: (entity: T) => Promise<Record<string, unknown>>;
	remove: () => Promise<void>;
}

/**
 * Without `confirm: true`: read the entity and describe what would be deleted. No write.
 * With it: DELETE, and say the deletion is not live until a version is published in the GTM UI (Q9).
 */
export async function deleteWithConfirm<T>(options: DeleteOptions<T>): Promise<CallToolResult> {
	const { kind, id } = options;
	if (options.confirm !== true) {
		const entity = await options.get();
		const related = options.related ? await options.related(entity) : {};
		return ok({
			preview: true,
			wouldDelete: compact({ kind, ...options.summarize(entity), ...related }),
			message: `Nothing was deleted. To delete this ${kind}, get the user's go-ahead, then call delete_${kind} again with confirm: true.`,
		});
	}
	await options.remove();
	return okWrite({ deleted: { kind, id } });
}
