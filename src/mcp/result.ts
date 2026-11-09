// Tool results: compact JSON for the model, noise trimmed, and every
// error turned into a short message instead of a thrown exception.

import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ListAllResult } from "../gtm/client";
import { GtmApiError, GtmInputError } from "../gtm/errors";
import { InvalidGtmIdError } from "../gtm/paths";

/** A successful result. Strings are sent as-is; anything else as compact JSON. */
export function ok(value: unknown): CallToolResult {
	return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

/** A failed result (`isError: true`) with a model-friendly message. Never includes tokens. */
export function fail(error: unknown): CallToolResult {
	return { content: [{ type: "text", text: errorMessage(error) }], isError: true };
}

export function errorMessage(error: unknown): string {
	if (typeof error === "string") return error;
	// These already carry safe, model-friendly messages (errors.ts, paths.ts).
	if (error instanceof GtmApiError || error instanceof GtmInputError || error instanceof InvalidGtmIdError) {
		return error.message;
	}
	if (error instanceof z.ZodError) {
		const issues = error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message));
		return `Invalid input: ${issues.join("; ")}`;
	}
	if (error instanceof Error) return `Unexpected error: ${error.message}`;
	return "Unexpected error.";
}

export interface CompactOptions {
	/**
	 * Drop `fingerprint` too. Use for list rows; keep it on single-entity reads, because
	 * updates need it for concurrency checks (GTM_API_QUIRKS.md Q2).
	 */
	dropFingerprint?: boolean;
}

/** Fields that only cost tokens: a UI deep link Google adds to every entity. */
const ALWAYS_DROPPED = new Set(["tagManagerUrl"]);

/**
 * Remove noise from a GTM API object, recursively: `tagManagerUrl`, `undefined`/`null`,
 * empty arrays and empty objects (and `fingerprint` when asked). Returns `undefined` when
 * nothing is left. Strings, numbers and booleans (including "" and false) are kept.
 */
export function compact<T>(value: T, options: CompactOptions = {}): T | undefined {
	return compactValue(value, options) as T | undefined;
}

function compactValue(value: unknown, options: CompactOptions): unknown {
	if (value === null || value === undefined) return undefined;
	if (Array.isArray(value)) {
		const items = value.map((v) => compactValue(v, options)).filter((v) => v !== undefined);
		return items.length ? items : undefined;
	}
	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, v] of Object.entries(value)) {
			if (ALWAYS_DROPPED.has(key) || (options.dropFingerprint && key === "fingerprint")) continue;
			const c = compactValue(v, options);
			if (c !== undefined) out[key] = c;
		}
		return Object.keys(out).length ? out : undefined;
	}
	return value;
}

/** A single entity (get_*): trimmed, fingerprint kept. */
export function okEntity(entity: unknown): CallToolResult {
	return ok(compact(entity) ?? {});
}

/**
 * A list (list_*): `{ <key>: rows }`, each row trimmed without its fingerprint. Adds
 * `truncated` and a note when the page cap was hit, so the model doesn't assume it saw
 * everything.
 */
export function okList<T, R>(key: string, list: ListAllResult<T>, toRow: (item: T) => R): CallToolResult {
	const rows = list.items.map((item) => compact(toRow(item), { dropFingerprint: true }) ?? {});
	const out: Record<string, unknown> = { [key]: rows };
	if (list.truncated) {
		out.truncated = true;
		out.note = `Only the first ${list.pages} pages were read; there are more ${key} than shown.`;
	}
	return ok(out);
}
