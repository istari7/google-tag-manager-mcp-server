// What still refers to a trigger or variable. GTM refuses to delete one that is still in use,
// with a bare 400 (Q26), so delete_trigger and delete_variable look this up: in the preview,
// to say the delete will fail, and after a refused DELETE, to say why. The lists share
// LIST_PAGE_BUDGET (Workers' subrequest cap), so on a huge workspace the check can be
// incomplete; the results then say they could not check everything.

import { type GtmClient, type ListAllOptions, pagesPerList } from "../gtm/client";
import { accounts, type Parameter, type Trigger, type Variable } from "../gtm/generated";
import { workspacePath } from "../gtm/paths";
import type { WorkspaceInput } from "./inputs";

const ws = accounts.containers.workspaces;

interface Ref {
	id: string | undefined;
	name: string | undefined;
}

export interface References {
	/** What uses the entity, by kind, e.g. `usedByTags`. */
	found: Record<string, Ref[]>;
	/** False when a list hit the page budget: something not in `found` may still use it. */
	complete: boolean;
}

export function listTags(gtm: GtmClient, ids: WorkspaceInput, options: ListAllOptions) {
	const parent = workspacePath(ids);
	return gtm.listAll(
		(pageToken) => ws.tags.list(gtm, { parent, pageToken }),
		(page) => page.tag,
		options,
	);
}

function listTriggers(gtm: GtmClient, ids: WorkspaceInput, options: ListAllOptions) {
	const parent = workspacePath(ids);
	return gtm.listAll(
		(pageToken) => ws.triggers.list(gtm, { parent, pageToken }),
		(page) => page.trigger,
		options,
	);
}

export function listVariables(gtm: GtmClient, ids: WorkspaceInput, options: ListAllOptions) {
	const parent = workspacePath(ids);
	return gtm.listAll(
		(pageToken) => ws.variables.list(gtm, { parent, pageToken }),
		(page) => page.variable,
		options,
	);
}

/** True when a parameter tree has a `triggerReference` to this trigger (trigger groups). */
function referencesTrigger(params: readonly Parameter[] | undefined, triggerId: string): boolean {
	return (params ?? []).some(
		(p) =>
			(p.type === "triggerReference" && p.value === triggerId) ||
			referencesTrigger(p.list, triggerId) ||
			referencesTrigger(p.map, triggerId),
	);
}

/** True when any string anywhere in `value` contains `needle`, e.g. "{{Page URL}}". */
function mentions(value: unknown, needle: string): boolean {
	if (typeof value === "string") return value.includes(needle);
	if (Array.isArray(value)) return value.some((v) => mentions(v, needle));
	if (typeof value === "object" && value !== null) return Object.values(value).some((v) => mentions(v, needle));
	return false;
}

/** The parts of an entity GTM resolves `{{…}}` in: not its own name or notes. */
function body<T extends { name?: string; notes?: string }>(entity: T): Omit<T, "name" | "notes"> {
	const { name: _name, notes: _notes, ...rest } = entity;
	return rest;
}

/** Tags that fire on or are blocked by the trigger, and trigger groups that list it. */
export async function triggerReferences(gtm: GtmClient, ids: WorkspaceInput, triggerId: string): Promise<References> {
	const budget = pagesPerList(2);
	const [tags, triggers] = await Promise.all([listTags(gtm, ids, budget), listTriggers(gtm, ids, budget)]);
	return {
		found: {
			usedByTags: tags.items
				.filter((t) => t.firingTriggerId?.includes(triggerId) || t.blockingTriggerId?.includes(triggerId))
				.map((t) => ({ id: t.tagId, name: t.name })),
			usedByTriggerGroups: triggers.items
				.filter((t: Trigger) => t.triggerId !== triggerId && referencesTrigger(t.parameter, triggerId))
				.map((t) => ({ id: t.triggerId, name: t.name })),
		},
		complete: !tags.truncated && !triggers.truncated,
	};
}

/** Tags, triggers and other variables that mention the variable as `{{name}}`. */
export async function variableReferences(gtm: GtmClient, ids: WorkspaceInput, variable: Variable): Promise<References> {
	if (!variable.name) return { found: {}, complete: true };
	const needle = `{{${variable.name}}}`;
	const budget = pagesPerList(3);
	const [tags, triggers, variables] = await Promise.all([
		listTags(gtm, ids, budget),
		listTriggers(gtm, ids, budget),
		listVariables(gtm, ids, budget),
	]);
	return {
		found: {
			usedByTags: tags.items.filter((t) => mentions(body(t), needle)).map((t) => ({ id: t.tagId, name: t.name })),
			usedByTriggers: triggers.items
				.filter((t) => mentions(body(t), needle))
				.map((t) => ({ id: t.triggerId, name: t.name })),
			usedByVariables: variables.items
				.filter((v) => v.variableId !== variable.variableId && mentions(body(v), needle))
				.map((v) => ({ id: v.variableId, name: v.name })),
		},
		complete: !tags.truncated && !triggers.truncated && !variables.truncated,
	};
}

/** What a check that hit the page budget says, in previews and errors. */
export function incompleteCheckNote(kind: string, what = "tags, triggers or variables"): string {
	return `Could not check all of the workspace (too large to read in one call), so other ${what} may also use this ${kind}.`;
}

function describeRefs(refs: References["found"]): string[] {
	const out: string[] = [];
	for (const [key, list] of Object.entries(refs)) {
		if (list.length === 0) continue;
		const what = key
			.replace(/^usedBy/, "")
			.replace(/([a-z])([A-Z])/g, "$1 $2")
			.toLowerCase();
		out.push(`${what} ${list.map((r) => `${r.id} "${r.name ?? ""}"`).join(", ")}`);
	}
	return out;
}

/**
 * Preview fields: the references, plus a warning when there are any, since GTM will refuse
 * the delete until they are removed (Q26).
 */
export function referencePreview(kind: string, refs: References, fix: string): Record<string, unknown> {
	const used = describeRefs(refs.found).length > 0;
	return {
		...refs.found,
		...(used ? { warning: `GTM will refuse to delete this ${kind} while these still use it. ${fix}` } : {}),
		...(refs.complete ? {} : { partial: true, partialNote: incompleteCheckNote(kind) }),
	};
}

/** The error after GTM refused the DELETE with a 400 (Q26). */
export function rejectedDeleteMessage(kind: string, id: string, refs: References, fix: string): string {
	const used = describeRefs(refs.found);
	const partial = refs.complete ? "" : ` ${incompleteCheckNote(kind)}`;
	return used.length > 0
		? `Nothing was deleted: GTM refuses to delete ${kind} ${id} while it is still used by ${used.join("; ")}. ${fix}${partial}`
		: `Nothing was deleted: GTM refused to delete ${kind} ${id}. This usually means something still uses it (Q26), e.g. a tag, trigger or variable in this workspace. Find and remove that use, then retry.${partial}`;
}
