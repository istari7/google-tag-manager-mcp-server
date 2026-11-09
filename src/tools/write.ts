// Helpers shared by the write tools: the result shape (entity + quirk warnings + the Q9
// note). Confirm-gated writes (deletes, publishing, access changes) are in ./confirm.ts.

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
