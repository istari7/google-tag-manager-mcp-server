// Get-merge-put for GTM updates.
//
// Q1: GTM updates are PUT = full replacement; anything left out is erased.
//     So we GET the stored entity, overlay the caller's fields, and PUT the lot.
// Q7: In a patch, `undefined` means "keep the stored value"; anything else,
//     including `[]` and `""`, replaces it (so `[]` clears a list, `""` clears notes).
// Q2: The stored fingerprint goes in the `fingerprint` query parameter, never
//     the body. If the caller read the entity earlier, it can pass that
//     fingerprint as `expectedFingerprint` to catch edits made in between.
// Q6: `uniqueTriggerId` is server-generated and never sent back.

import type { GtmRequester } from "./client";
import { GtmApiError } from "./errors";
import { type Account, accounts, type Folder, type Tag, type Trigger, type Variable } from "./generated";
import {
	type Normalized,
	normalizeTag,
	normalizeTrigger,
	normalizeVariable,
	type TagInput,
	type TriggerInput,
} from "./quirks";

/** Fields that never go in a write body: the fingerprint travels as a query parameter (Q2), uniqueTriggerId is server-made (Q6). */
const NEVER_SENT = ["fingerprint", "uniqueTriggerId"] as const;

/** Shallow overlay: a key whose patch value is `undefined` keeps the current value (Q1, Q7). */
export function mergeForUpdate<T extends object>(current: T, patch: Partial<T>): T {
	const merged: T = { ...current };
	for (const key of Object.keys(patch) as Array<keyof T>) {
		const value = patch[key];
		if (value !== undefined) merged[key] = value as T[keyof T];
	}
	return merged;
}

/** Remove fields that must not be sent in a create/update body. Returns a copy. */
export function stripServerFields<T extends object>(body: T): T {
	const out: T = { ...body };
	for (const key of NEVER_SENT) {
		if (key in out) delete (out as Record<string, unknown>)[key];
	}
	return out;
}

export interface PreparedUpdate<T> {
	/** The full object to PUT. */
	body: T;
	/** Goes in the `fingerprint` query parameter (Q2). */
	fingerprint: string | undefined;
}

/** Pure core of get-merge-put: merge, then strip server-only fields. */
export function prepareUpdate<T extends { fingerprint?: string }>(current: T, patch: Partial<T>): PreparedUpdate<T> {
	return { body: stripServerFields(mergeForUpdate(current, patch)), fingerprint: current.fingerprint };
}

export interface GetMergePutOptions<T extends { fingerprint?: string }, P> {
	get: () => Promise<T>;
	put: (body: T, fingerprint: string | undefined) => Promise<T>;
	patch: P;
	/** Turn the caller's patch into a Partial<T>, given the stored entity (quirk fixes go here). */
	normalize: (patch: P, current: T) => Normalized<Partial<T>>;
	/** If set and different from the stored fingerprint, fail with a conflict instead of writing. */
	expectedFingerprint?: string;
	/** For error messages. */
	path: string;
}

export interface UpdateResult<T> {
	result: T;
	warnings: string[];
}

/** GET the entity, merge the normalised patch, PUT it with the stored fingerprint. */
export async function getMergePut<T extends { fingerprint?: string }, P>(
	options: GetMergePutOptions<T, P>,
): Promise<UpdateResult<T>> {
	const current = await options.get();
	if (options.expectedFingerprint !== undefined && options.expectedFingerprint !== current.fingerprint) {
		throw GtmApiError.conflict("PUT", options.path);
	}
	const { value, warnings } = options.normalize(options.patch, current);
	const { body, fingerprint } = prepareUpdate(current, value);
	const result = await options.put(body, fingerprint);
	return { result, warnings };
}

export interface UpdateOptions {
	/** Fingerprint from the caller's earlier read; a mismatch fails with a conflict (Q2). */
	expectedFingerprint?: string;
}

const ws = accounts.containers.workspaces;

const plain = <T>(patch: Partial<T>): Normalized<Partial<T>> => ({ value: patch, warnings: [] });

export function updateTag(client: GtmRequester, path: string, patch: TagInput, options: UpdateOptions = {}) {
	return getMergePut<Tag, TagInput>({
		path,
		patch,
		expectedFingerprint: options.expectedFingerprint,
		get: () => ws.tags.get(client, { path }),
		put: (body, fingerprint) => ws.tags.update(client, { path, fingerprint }, body),
		normalize: normalizeTag,
	});
}

export function updateTrigger(client: GtmRequester, path: string, patch: TriggerInput, options: UpdateOptions = {}) {
	return getMergePut<Trigger, TriggerInput>({
		path,
		patch,
		expectedFingerprint: options.expectedFingerprint,
		get: () => ws.triggers.get(client, { path }),
		put: (body, fingerprint) => ws.triggers.update(client, { path, fingerprint }, body),
		normalize: normalizeTrigger,
	});
}

export function updateVariable(
	client: GtmRequester,
	path: string,
	patch: Partial<Variable>,
	options: UpdateOptions = {},
) {
	return getMergePut<Variable, Partial<Variable>>({
		path,
		patch,
		expectedFingerprint: options.expectedFingerprint,
		get: () => ws.variables.get(client, { path }),
		put: (body, fingerprint) => ws.variables.update(client, { path, fingerprint }, body),
		normalize: normalizeVariable,
	});
}

export function updateFolder(client: GtmRequester, path: string, patch: Partial<Folder>, options: UpdateOptions = {}) {
	return getMergePut<Folder, Partial<Folder>>({
		path,
		patch,
		expectedFingerprint: options.expectedFingerprint,
		get: () => ws.folders.get(client, { path }),
		put: (body, fingerprint) => ws.folders.update(client, { path, fingerprint }, body),
		normalize: plain,
	});
}

export function updateAccount(
	client: GtmRequester,
	path: string,
	patch: Partial<Account>,
	options: UpdateOptions = {},
) {
	return getMergePut<Account, Partial<Account>>({
		path,
		patch,
		expectedFingerprint: options.expectedFingerprint,
		get: () => accounts.get(client, { path }),
		put: (body, fingerprint) => accounts.update(client, { path, fingerprint }, body),
		normalize: plain,
	});
}

/** Create a trigger with the same quirk handling as updates (Q3–Q6). `parent` is the workspace path. */
export async function createTrigger(
	client: GtmRequester,
	parent: string,
	input: TriggerInput,
): Promise<UpdateResult<Trigger>> {
	const { value, warnings } = normalizeTrigger(input);
	const result = await ws.triggers.create(client, { parent }, stripServerFields(value));
	return { result, warnings };
}

/** Create a variable with the Q15 fix applied. `parent` is the workspace path. */
export async function createVariable(
	client: GtmRequester,
	parent: string,
	input: Variable,
): Promise<UpdateResult<Variable>> {
	const { value, warnings } = normalizeVariable(input);
	const result = await ws.variables.create(client, { parent }, stripServerFields(value));
	return { result, warnings };
}

/** Create a tag with the Q14 consent shorthand applied. `parent` is the workspace path. */
export async function createTag(client: GtmRequester, parent: string, input: TagInput): Promise<UpdateResult<Tag>> {
	const { value, warnings } = normalizeTag(input);
	const result = await ws.tags.create(client, { parent }, stripServerFields(value));
	return { result, warnings };
}
