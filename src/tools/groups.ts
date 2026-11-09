// GTM_TOOL_GROUPS: which tool families appear in tools/list. Modelled on Paolo's
// gtm/tools.go (ParseToolGroups, defaultToolGroupNames, optionalToolGroupNames, "all") and
// using his group names, so a value that works there works here.
//
// The default set keeps the tools/list response under 40 KB (test/tools-list.test.ts).
// Unlike Paolo's, `templates`, `zones` and `server` are optional here: his budget is 80 KB,
// ours is 40 KB, and zones (GTM 360) and server (server-side containers) are niche. Groups
// with no tools yet are accepted so modules can be added without touching this file.
// Which tools are in which group: TOOL_MODULES in src/tools/index.ts, and the README.

/** On when GTM_TOOL_GROUPS is unset or empty. Order is tools/list order. */
export const DEFAULT_TOOL_GROUPS = [
	"accounts",
	"workspaces",
	"tags",
	"triggers",
	"variables",
	"folders",
	"builtins",
	"guidance",
] as const;

/** Off unless named (or `all`). */
export const OPTIONAL_TOOL_GROUPS = [
	"templates",
	"zones",
	"server",
	"environments",
	"destinations",
	"gtag",
	"users",
	"container-admin",
	"folder-admin",
	"workspace-admin",
	"version-admin",
	"reverts",
] as const;

export type ToolGroupName = (typeof DEFAULT_TOOL_GROUPS)[number] | (typeof OPTIONAL_TOOL_GROUPS)[number];

export const TOOL_GROUP_NAMES: readonly ToolGroupName[] = [...DEFAULT_TOOL_GROUPS, ...OPTIONAL_TOOL_GROUPS];

/** Keywords besides the group names: `all` = every group, `default` = DEFAULT_TOOL_GROUPS. */
const KEYWORDS = ["all", "default"] as const;

export type ToolGroupSelection = ReadonlySet<ToolGroupName>;

/** A bad GTM_TOOL_GROUPS value. The message is safe to show: it echoes only name-shaped input. */
export class ToolGroupsError extends Error {
	override readonly name = "ToolGroupsError";
}

const isGroupName = (name: string): name is ToolGroupName => (TOOL_GROUP_NAMES as readonly string[]).includes(name);

/**
 * Parse GTM_TOOL_GROUPS: comma-separated, case-insensitive, whitespace ignored. Unset or empty
 * means the default groups; `all` means every group; `default` can be combined with others
 * (`default,users`). Throws ToolGroupsError on an unknown name.
 */
export function parseToolGroups(value: string | undefined): ToolGroupSelection {
	const names = (value ?? "")
		.split(",")
		.map((name) => name.trim().toLowerCase())
		.filter((name) => name !== "");
	if (names.length === 0) return new Set(DEFAULT_TOOL_GROUPS);

	const groups = new Set<ToolGroupName>();
	for (const name of names) {
		if (name === "all" || name === "default") {
			for (const g of name === "all" ? TOOL_GROUP_NAMES : DEFAULT_TOOL_GROUPS) groups.add(g);
		} else if (isGroupName(name)) groups.add(name);
		else {
			// Echo the name only when it looks like one: the variable should never hold a secret,
			// but if someone pastes one there it must not end up in a response or a log.
			const shown = /^[a-z0-9_-]{1,32}$/.test(name) ? `"${name}"` : "(not shown: not a group name)";
			throw new ToolGroupsError(
				`GTM_TOOL_GROUPS has an unknown tool group ${shown}. Use a comma-separated list of: ${[...KEYWORDS, ...TOOL_GROUP_NAMES].join(", ")}.`,
			);
		}
	}
	return groups;
}

/** The selected groups in canonical order, for display. */
export function describeToolGroups(groups: ToolGroupSelection): string[] {
	return TOOL_GROUP_NAMES.filter((g) => groups.has(g));
}

export function isDefaultSelection(groups: ToolGroupSelection): boolean {
	return groups.size === DEFAULT_TOOL_GROUPS.length && DEFAULT_TOOL_GROUPS.every((g) => groups.has(g));
}
