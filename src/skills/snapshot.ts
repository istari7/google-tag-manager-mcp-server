// Live GTM data for the prompts of skills with `live-data` (src/skills/prompts.ts): fetched with
// the signed-in user's GTM client and rendered as compact markdown + JSON rows. Parameters are
// abridged; the text points the model at get_* for the full entity.

import type { GtmClient, ListAllResult } from "../gtm/client";
import {
	accounts,
	type Condition,
	type Folder,
	type Parameter,
	type Tag,
	type Trigger,
	type Variable,
	type Workspace,
} from "../gtm/generated";
import { type ContainerIds, containerPath, type WorkspaceIds, workspacePath } from "../gtm/paths";
import { compact } from "../mcp/result";

/** Longest parameter value or note shown; longer ones end in "…". */
export const MAX_VALUE = 300;
/** Rows per entity kind. */
export const MAX_ROWS = 300;

const cut = (value: string, max = MAX_VALUE) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** A parameter's value as one line: template/boolean/integer as is, lists as [..], maps as {k: v}. */
function flat(p: Parameter): string {
	if (p.list) return `[${p.list.map(flat).join(", ")}]`;
	if (p.map) return `{${p.map.map((m) => `${m.key ?? "?"}: ${flat(m)}`).join(", ")}}`;
	return p.value ?? "";
}

function params(list: readonly Parameter[] | undefined): Record<string, string> | undefined {
	if (!list?.length) return undefined;
	return Object.fromEntries(list.map((p) => [p.key ?? "?", cut(flat(p))]));
}

/** `{{Page Path}} startsWith "/account"`, with "not" for negate and "(ignore case)". */
function condition(c: Condition): string {
	const arg = (key: string) => c.parameter?.find((p) => p.key === key)?.value;
	const negate = arg("negate") === "true" ? "not " : "";
	const ignoreCase = arg("ignore_case") === "true" ? " (ignore case)" : "";
	return cut(`${arg("arg0") ?? "?"} ${negate}${c.type ?? "?"} ${JSON.stringify(arg("arg1") ?? "")}${ignoreCase}`);
}

const conditions = (list: readonly Condition[] | undefined) => (list?.length ? list.map(condition) : undefined);

/** Every string value in parameters and conditions, for counting {{Variable}} references. */
function strings(list: readonly Parameter[] | undefined, out: string[]): void {
	for (const p of list ?? []) {
		if (p.value) out.push(p.value);
		strings(p.list, out);
		strings(p.map, out);
	}
}

/** Trigger fields that hold a single Parameter (timer interval, CSS selector, …). */
const TRIGGER_SETTINGS = [
	"eventName",
	"selector",
	"interval",
	"intervalSeconds",
	"limit",
	"maxTimerLengthSeconds",
	"waitForTags",
	"waitForTagsTimeout",
	"checkValidation",
	"verticalScrollPercentageList",
	"horizontalScrollPercentageList",
	"visibilitySelector",
	"visiblePercentageMin",
	"visiblePercentageMax",
	"continuousTimeMinMilliseconds",
	"totalTimeMinMilliseconds",
] as const satisfies readonly (keyof Trigger)[];

function triggerSettings(t: Trigger): Record<string, string> | undefined {
	const out: Record<string, string> = {};
	for (const key of TRIGGER_SETTINGS) {
		const p: Parameter | undefined = t[key];
		if (p) out[key] = cut(flat(p));
	}
	return Object.keys(out).length ? out : undefined;
}

function consent(t: Tag): string | undefined {
	const status = t.consentSettings?.consentStatus;
	if (!status || status === "notSet") return undefined;
	const types = t.consentSettings?.consentType;
	return status === "needed" && types ? `needed: ${flat(types).replace(/^\[|\]$/g, "")}` : status;
}

/** JSON array with one row per line: compact, but still easy for a model to scan. */
function rows(items: readonly unknown[]): string {
	return items.length ? `[\n${items.map((i) => JSON.stringify(i)).join(",\n")}\n]` : "[]";
}

function section<T>(heading: string, list: ListAllResult<T>, render: (item: T) => unknown, listTool: string): string {
	const shown = list.items.slice(0, MAX_ROWS);
	const more = list.truncated || list.items.length > MAX_ROWS;
	const note = more ? `\n\nOnly the first ${shown.length} are shown; call \`${listTool}\` for the rest.` : "";
	return `### ${heading} (${list.items.length}${list.truncated ? "+" : ""})\n\n\`\`\`json\n${rows(shown.map(render))}\n\`\`\`${note}`;
}

/** Tags, triggers, variables and folders of one workspace, as a markdown section. */
export async function workspaceSnapshot(gtm: GtmClient, ids: WorkspaceIds): Promise<string> {
	const parent = workspacePath(ids);
	const ws = accounts.containers.workspaces;
	const [tags, triggers, variables, folders] = await Promise.all([
		gtm.listAll(
			(pageToken) => ws.tags.list(gtm, { parent, pageToken }),
			(page) => page.tag,
		),
		gtm.listAll(
			(pageToken) => ws.triggers.list(gtm, { parent, pageToken }),
			(page) => page.trigger,
		),
		gtm.listAll(
			(pageToken) => ws.variables.list(gtm, { parent, pageToken }),
			(page) => page.variable,
		),
		gtm.listAll(
			(pageToken) => ws.folders.list(gtm, { parent, pageToken }),
			(page) => page.folder,
		),
	]);

	const folderName = new Map(folders.items.map((f) => [f.folderId, f.name]));
	const folder = (id: string | undefined) => (id ? (folderName.get(id) ?? id) : undefined);

	// How often each trigger is used (tags firing/blocking on it, trigger groups listing it).
	const triggerUse = new Map<string, number>();
	const use = (id: string) => triggerUse.set(id, (triggerUse.get(id) ?? 0) + 1);
	for (const t of tags.items) for (const id of [...(t.firingTriggerId ?? []), ...(t.blockingTriggerId ?? [])]) use(id);
	const triggerRefs = (list: readonly Parameter[] | undefined): void => {
		for (const p of list ?? []) {
			if (p.type === "triggerReference" && p.value) use(p.value);
			triggerRefs(p.list);
			triggerRefs(p.map);
		}
	};
	for (const t of triggers.items) triggerRefs(t.parameter);

	// Every string a {{Variable}} could appear in.
	const texts: string[] = [];
	for (const t of tags.items) strings(t.parameter, texts);
	for (const v of variables.items) strings(v.parameter, texts);
	for (const t of triggers.items) {
		strings(t.parameter, texts);
		for (const c of [...(t.filter ?? []), ...(t.autoEventFilter ?? []), ...(t.customEventFilter ?? [])]) {
			strings(c.parameter, texts);
		}
	}
	const allText = texts.join("\n");
	const references = (name: string | undefined) => (name ? allText.split(`{{${name}}}`).length - 1 : 0);

	const tagRow = (t: Tag) =>
		compact({
			tagId: t.tagId,
			name: t.name,
			type: t.type,
			folder: folder(t.parentFolderId),
			firing: t.firingTriggerId,
			blocking: t.blockingTriggerId,
			paused: t.paused || undefined,
			consent: consent(t),
			firingOption: t.tagFiringOption === "oncePerEvent" ? undefined : t.tagFiringOption,
			setup: t.setupTag?.map((s) => s.tagName),
			teardown: t.teardownTag?.map((s) => s.tagName),
			notes: t.notes ? cut(t.notes) : undefined,
			parameters: params(t.parameter),
		});
	const triggerRow = (t: Trigger) =>
		compact({
			triggerId: t.triggerId,
			name: t.name,
			type: t.type,
			folder: folder(t.parentFolderId),
			usedBy: triggerUse.get(t.triggerId ?? "") ?? 0,
			customEventFilter: conditions(t.customEventFilter),
			filter: conditions(t.filter),
			autoEventFilter: conditions(t.autoEventFilter),
			settings: triggerSettings(t),
			parameters: params(t.parameter),
			notes: t.notes ? cut(t.notes) : undefined,
		});
	const variableRow = (v: Variable) =>
		compact({
			variableId: v.variableId,
			name: v.name,
			type: v.type,
			folder: folder(v.parentFolderId),
			references: references(v.name),
			parameters: params(v.parameter),
			notes: v.notes ? cut(v.notes) : undefined,
		});
	const folderRow = (f: Folder) => compact({ folderId: f.folderId, name: f.name });

	return [
		`## Live data: workspace \`${parent}\``,
		"",
		"Read from the GTM API for this prompt. Parameter values and notes longer than " +
			`${MAX_VALUE} characters are cut (…); use \`get_tag\`, \`get_trigger\` or \`get_variable\` for ` +
			"the full entity. `firing`/`blocking` are trigger IDs. `usedBy` counts the tags and trigger " +
			"groups that use a trigger. `references` counts `{{Name}}` uses of a variable in tags, triggers " +
			"and variables (built-in variables are not listed).",
		"",
		section("Tags", tags, tagRow, "list_tags"),
		"",
		section("Triggers", triggers, triggerRow, "list_triggers"),
		"",
		section("Variables", variables, variableRow, "list_variables"),
		"",
		section("Folders", folders, folderRow, "list_folders"),
	].join("\n");
}

/** A container and its workspaces, as a markdown section. */
export async function containerSnapshot(gtm: GtmClient, ids: ContainerIds): Promise<string> {
	const path = containerPath(ids);
	const [container, workspaces] = await Promise.all([
		accounts.containers.get(gtm, { path }),
		gtm.listAll(
			(pageToken) => accounts.containers.workspaces.list(gtm, { parent: path, pageToken }),
			(page) => page.workspace,
		),
	]);
	const summary = compact({
		containerId: container.containerId,
		name: container.name,
		publicId: container.publicId,
		usageContext: container.usageContext,
		domainName: container.domainName,
	});
	const workspaceRow = (w: Workspace) =>
		compact({ workspaceId: w.workspaceId, name: w.name, description: w.description ? cut(w.description) : undefined });
	return [
		`## Live data: container \`${path}\``,
		"",
		"Read from the GTM API for this prompt. Standard (non-360) containers allow three workspaces, " +
			"`Default Workspace` included.",
		"",
		`\`\`\`json\n${JSON.stringify(summary)}\n\`\`\``,
		"",
		section("Workspaces", workspaces, workspaceRow, "list_workspaces"),
	].join("\n");
}
