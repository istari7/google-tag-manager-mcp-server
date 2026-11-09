// Live GTM data for the prompts of skills with `live-data` (src/skills/prompts.ts): fetched with
// the signed-in user's GTM client and returned as compact JSON rows, which the prompt embeds as
// a separate resource (untrusted data, kept apart from the skill's instructions). Parameters are
// abridged; the legend points the model at get_* for the full entity. All lists together read
// at most LIST_PAGE_BUDGET pages (Workers' subrequest cap); a list that hit it is `partial`.

import { type GtmClient, type ListAllResult, pagesPerList } from "../gtm/client";
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

/** Live data for one prompt: the JSON the prompt embeds, its URI, and how to read it. */
export interface LiveData {
	/** Names the embedded resource, e.g. gtm://live/accounts/1/containers/2/workspaces/3. */
	readonly uri: string;
	/** What the data is and what its fields mean. Goes with the instructions, not the data. */
	readonly legend: string;
	readonly data: Readonly<Record<string, unknown>>;
}

/** URI prefix of embedded live data. Not a readable resource: the data exists only in the prompt. */
export const LIVE_DATA_URI = "gtm://live";

/** One list's rows. `partial`: the page budget ran out, so the list (and counts built on it) is incomplete. */
export interface Section {
	count: number;
	partial?: true;
	note?: string;
	rows: unknown[];
}

function section<T>(list: ListAllResult<T>, render: (item: T) => unknown, listTool: string): Section {
	const shown = list.items.slice(0, MAX_ROWS);
	const more = list.truncated || list.items.length > MAX_ROWS;
	return {
		count: list.items.length,
		...(list.truncated ? { partial: true as const } : {}),
		...(more ? { note: `Only ${shown.length} are shown; call ${listTool} for the rest.` } : {}),
		rows: shown.map(render),
	};
}

/** Tags, triggers, variables and folders of one workspace. */
export async function workspaceSnapshot(gtm: GtmClient, ids: WorkspaceIds): Promise<LiveData> {
	const parent = workspacePath(ids);
	const ws = accounts.containers.workspaces;
	const budget = pagesPerList(4);
	const [tags, triggers, variables, folders] = await Promise.all([
		gtm.listAll(
			(pageToken) => ws.tags.list(gtm, { parent, pageToken }),
			(page) => page.tag,
			budget,
		),
		gtm.listAll(
			(pageToken) => ws.triggers.list(gtm, { parent, pageToken }),
			(page) => page.trigger,
			budget,
		),
		gtm.listAll(
			(pageToken) => ws.variables.list(gtm, { parent, pageToken }),
			(page) => page.variable,
			budget,
		),
		gtm.listAll(
			(pageToken) => ws.folders.list(gtm, { parent, pageToken }),
			(page) => page.folder,
			budget,
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

	const partial = [tags, triggers, variables, folders].some((l) => l.truncated);
	return {
		uri: `${LIVE_DATA_URI}/${parent}`,
		legend:
			`The tags, triggers, variables and folders of workspace \`${parent}\`. Parameter values and notes ` +
			`longer than ${MAX_VALUE} characters are cut (…); use \`get_tag\`, \`get_trigger\` or ` +
			"`get_variable` for the full entity. `firing`/`blocking` are trigger IDs. `usedBy` counts the tags " +
			"and trigger groups that use a trigger. `references` counts `{{Name}}` uses of a variable in tags, " +
			"triggers and variables (built-in variables are not listed)." +
			(partial
				? " A list marked `partial` could not be read in full (the workspace is very large), so `usedBy` and `references` may be too low: check with the list_* tools before calling anything unused."
				: ""),
		data: {
			workspace: parent,
			tags: section(tags, tagRow, "list_tags"),
			triggers: section(triggers, triggerRow, "list_triggers"),
			variables: section(variables, variableRow, "list_variables"),
			folders: section(folders, folderRow, "list_folders"),
		},
	};
}

/** A container and its workspaces. */
export async function containerSnapshot(gtm: GtmClient, ids: ContainerIds): Promise<LiveData> {
	const path = containerPath(ids);
	const [container, workspaces] = await Promise.all([
		accounts.containers.get(gtm, { path }),
		gtm.listAll(
			(pageToken) => accounts.containers.workspaces.list(gtm, { parent: path, pageToken }),
			(page) => page.workspace,
			pagesPerList(1),
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
	return {
		uri: `${LIVE_DATA_URI}/${path}`,
		legend:
			`Container \`${path}\` and its workspaces. Standard (non-360) containers allow three workspaces, ` +
			"`Default Workspace` included.",
		data: { container: summary, workspaces: section(workspaces, workspaceRow, "list_workspaces") },
	};
}
