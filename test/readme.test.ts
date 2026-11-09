// The README's tool table (## Tools) must list every registered tool exactly once, under the
// GTM_TOOL_GROUPS group that registers it. README.md is bundled as a Text module (the
// `**/*.md` rule in wrangler.jsonc), so the workerd test can read it.

import { describe, expect, it } from "vitest";
import readme from "../README.md";
import { TOOL_GROUP_NAMES } from "../src/tools/groups";
import { fakeProps } from "./helpers/props";
import { rpc } from "./tools/helpers";

async function toolNames(toolGroups: string): Promise<string[]> {
	const { result } = await rpc("tools/list", {}, fakeProps(), toolGroups);
	return (result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
}

/** Group → tools, from the rows of the first table under "## Tools". */
function readmeTable(): Map<string, string[]> {
	const section = readme.split(/^## Tools$/m)[1]?.split(/^#{2,3} /m)[0] ?? "";
	const rows = section.split("\n").filter((line) => /^\| (`[^`]+`[^|]*)?\| `/.test(line));
	const groups = new Map<string, string[]>();
	let group = "";
	for (const row of rows) {
		const [groupCell = "", toolCell = ""] = row.split("|").slice(1, 3);
		const named = /`([a-z-]+)`/.exec(groupCell)?.[1];
		if (named) group = named;
		const tools = [...toolCell.matchAll(/`([a-z_]+)`/g)].map((m) => m[1] ?? "");
		groups.set(group, [...(groups.get(group) ?? []), ...tools]);
	}
	return groups;
}

describe("README tool table", () => {
	it("lists every tool once, in the group that registers it", async () => {
		const table = readmeTable();
		// core: the tools every selection lists.
		const users = await toolNames("users");
		const core = (await toolNames("tags")).filter((name) => users.includes(name));
		const expected = new Map<string, string[]>([["core", core]]);
		for (const group of TOOL_GROUP_NAMES) {
			const names = (await toolNames(group)).filter((name) => !core.includes(name));
			if (names.length > 0) expected.set(group, names);
		}
		const sorted = (m: Map<string, string[]>) =>
			Object.fromEntries(
				[...m].map(([g, names]) => [g, [...names].sort()]).sort(([a], [b]) => String(a).localeCompare(String(b))),
			);
		expect(sorted(table)).toEqual(sorted(expected));

		const listed = [...table.values()].flat();
		expect(new Set(listed).size).toBe(listed.length);
		expect(listed.length).toBe((await toolNames("all")).length);
	});
});
