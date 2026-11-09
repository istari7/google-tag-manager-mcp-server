// GTM_TOOL_GROUPS: parsing, which tools each configuration lists, and what a bad value does
// to /mcp and /setup.

import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { authHandler } from "../src/auth/handler";
import {
	DEFAULT_TOOL_GROUPS,
	OPTIONAL_TOOL_GROUPS,
	parseToolGroups,
	TOOL_GROUP_NAMES,
	ToolGroupsError,
} from "../src/tools/groups";
import { ORIGIN } from "./helpers/oauth";
import { fakeProps } from "./helpers/props";
import { rawRpc, rpc } from "./tools/helpers";

const CORE = ["ping", "auth_status"];

async function toolNames(toolGroups: string): Promise<string[]> {
	const { result } = await rpc("tools/list", {}, fakeProps(), toolGroups);
	return (result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
}

const sorted = (names: Iterable<string>) => [...names].sort();

describe("parseToolGroups", () => {
	it("uses the default groups when unset, empty or only separators", () => {
		for (const value of [undefined, "", "  ", " , ,"]) {
			expect(sorted(parseToolGroups(value)), String(value)).toEqual(sorted(DEFAULT_TOOL_GROUPS));
		}
	});

	it("trims, lowercases and ignores empty entries", () => {
		expect(sorted(parseToolGroups(" Tags ,, ZONES ,"))).toEqual(["tags", "zones"]);
	});

	it("expands all to every group, and default to the default groups", () => {
		expect(sorted(parseToolGroups("all"))).toEqual(sorted(TOOL_GROUP_NAMES));
		expect(sorted(parseToolGroups("ALL,tags"))).toEqual(sorted(TOOL_GROUP_NAMES));
		expect(sorted(parseToolGroups("default,users,gtag"))).toEqual(sorted([...DEFAULT_TOOL_GROUPS, "users", "gtag"]));
	});

	it("accepts every group name, including groups with no tools yet", () => {
		for (const name of [...DEFAULT_TOOL_GROUPS, ...OPTIONAL_TOOL_GROUPS]) {
			expect([...parseToolGroups(name)]).toEqual([name]);
		}
		// Paolo's names (gtm/tools.go), so a value that works there works here.
		for (const name of [
			"accounts",
			"workspaces",
			"tags",
			"triggers",
			"variables",
			"folders",
			"builtins",
			"zones",
			"templates",
			"server",
			"guidance",
			"environments",
			"destinations",
			"gtag",
			"container-admin",
			"folder-admin",
			"workspace-admin",
			"version-admin",
			"reverts",
		]) {
			expect(TOOL_GROUP_NAMES).toContain(name);
		}
	});

	it("rejects an unknown name, naming it and listing the valid ones", () => {
		expect(() => parseToolGroups("tags,tgas")).toThrow(ToolGroupsError);
		expect(() => parseToolGroups("tags,tgas")).toThrow(/unknown tool group "tgas".*all, default, accounts/);
		expect(() => parseToolGroups("core")).toThrow(ToolGroupsError);
	});

	it("does not echo a value that isn't name-shaped (it could be a pasted secret)", () => {
		const secret = "ya29.a0AfH6SMBsecretLookingValue";
		const error = (() => {
			try {
				parseToolGroups(`tags,${secret}`);
			} catch (e) {
				return e;
			}
		})();
		expect(error).toBeInstanceOf(ToolGroupsError);
		expect((error as Error).message).not.toContain(secret);
		expect((error as Error).message.toLowerCase()).not.toContain(secret.toLowerCase());
		expect((error as Error).message).toContain("not shown");
	});
});

describe("tools per configuration", () => {
	it("one group lists the always-on core tools plus that group's", async () => {
		expect(await toolNames("tags")).toEqual([
			...CORE,
			"list_tags",
			"get_tag",
			"create_tag",
			"update_tag",
			"delete_tag",
		]);
	});

	it("an optional group adds only its own tools", async () => {
		expect(await toolNames("zones")).toEqual([
			...CORE,
			"list_zones",
			"get_zone",
			"create_zone",
			"update_zone",
			"delete_zone",
		]);
	});

	it("the default leaves out the optional groups", async () => {
		const names = await toolNames("");
		expect(names).toEqual(await toolNames("default"));
		// By group, not by tool name, so renamed or added tools don't break this test.
		for (const group of OPTIONAL_TOOL_GROUPS) {
			for (const name of (await toolNames(group)).filter((n) => !CORE.includes(n))) {
				expect(names, `${name} (${group})`).not.toContain(name);
			}
		}
		for (const group of DEFAULT_TOOL_GROUPS) {
			for (const name of await toolNames(group)) expect(names, `${name} (${group})`).toContain(name);
		}
		expect((await toolNames("users")).length).toBeGreaterThan(CORE.length);
		expect((await toolNames("gtag")).length).toBeGreaterThan(CORE.length);
		for (const everyday of ["list_folders", "create_tag", "publish_version", "delete_container"]) {
			expect(names).toContain(everyday);
		}
	});

	it("puts every tool in exactly one group (or core), and all lists them all", async () => {
		const all = await toolNames("all");
		const membership: Record<string, string[]> = {};
		const seen = new Map<string, string>();
		for (const group of TOOL_GROUP_NAMES) {
			const own = (await toolNames(group)).filter((n) => !CORE.includes(n));
			membership[group] = own;
			for (const name of own) {
				expect(seen.get(name), `${name} is in ${seen.get(name)} and ${group}`).toBeUndefined();
				seen.set(name, group);
			}
		}
		expect(sorted([...CORE, ...seen.keys()])).toEqual(sorted(all));
		// The group → tools map, for review in diffs (README "Tool groups" documents it).
		expect(membership).toMatchSnapshot();
	});

	it("a tool outside the selected groups can't be called", async () => {
		const { result, error } = await rpc(
			"tools/call",
			{ name: "list_user_permissions", arguments: {} },
			fakeProps(),
			"",
		);
		const failed = error !== undefined || (result as { isError?: boolean }).isError === true;
		expect(failed).toBe(true);
	});
});

describe("an invalid GTM_TOOL_GROUPS", () => {
	it("fails every /mcp request with a message naming the bad group", async () => {
		const res = await rawRpc("tools/list", {}, fakeProps(), "tags,tgas");
		expect(res.status).toBe(500);
		const body = (await res.json()) as { jsonrpc: string; error: { code: number; message: string } };
		expect(body.jsonrpc).toBe("2.0");
		expect(body.error.code).toBe(-32603);
		expect(body.error.message).toContain('unknown tool group "tgas"');
	});

	it("never echoes a secret-looking value", async () => {
		const res = await rawRpc("tools/list", {}, fakeProps(), "Bearer abc.def/ghi");
		expect(res.status).toBe(500);
		expect(await res.text()).not.toContain("abc.def/ghi");
	});

	it("shows on /setup, which then says not ready", async () => {
		const setup = (value: string) =>
			authHandler.fetch(new Request(`${ORIGIN}/setup`), { ...env, GTM_TOOL_GROUPS: value }, createExecutionContext());
		const bad = await (await setup("tags,tgas")).text();
		expect(bad).toContain("❌ Not ready.");
		expect(bad).toContain("❌ <code>GTM_TOOL_GROUPS</code>: GTM_TOOL_GROUPS has an unknown tool group &#34;tgas&#34;");

		const good = await (await setup("")).text();
		expect(good).toContain("✅ Ready.");
		expect(good).toContain("✅ Tool groups (default): <code>accounts</code>, <code>workspaces</code>");
		const custom = await (await setup("tags, Users")).text();
		expect(custom).toContain("✅ Tool groups: <code>tags</code>, <code>users</code>");
	});
});
