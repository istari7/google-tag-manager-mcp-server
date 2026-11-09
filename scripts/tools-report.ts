// Print the byte size of the tools/list response per tool group (GTM_TOOL_GROUPS), for the
// default groups and for `all`. Budget: the default response < 40 KB.
//
//   pnpm tools-report          (= node scripts/tools-report.ts)
//   node scripts/tools-report.ts --tools   also list every tool with its bytes
//   node scripts/tools-report.ts --json    also print the default tools/list JSON
//   node scripts/tools-report.ts --groups=all   measure that GTM_TOOL_GROUPS value instead of the default
//
// Runs on plain Node 24 (native type stripping) against the real buildServer() from
// src/mcp/server.ts. The source is written for the Workers bundler, so a few module hooks
// bridge the gap: extensionless relative imports resolve to .ts, *.md loads as a text
// module (like the `rules` in wrangler.jsonc), package.json gets its named `version` export,
// and `agents/mcp` (the Workers HTTP handler, unused here) is stubbed. Nothing calls Google.

import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";

const BUDGET_BYTES = 40 * 1024;

const AGENTS_STUB = `data:text/javascript,${encodeURIComponent(
	"export function createMcpHandler() { throw new Error('agents/mcp is not available in tools-report'); }",
)}`;

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "agents/mcp") return { url: AGENTS_STUB, shortCircuit: true };
		const parent = context.parentURL;
		if (/^\.\.?\//.test(specifier) && parent?.startsWith("file:") && !/\.[a-z]+$/i.test(specifier)) {
			for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
				const url = new URL(candidate, parent);
				if (existsSync(url)) return { url: url.href, shortCircuit: true };
			}
		}
		return nextResolve(specifier, context);
	},
	load(url, context, nextLoad) {
		if (url.startsWith("file:") && url.endsWith(".md")) {
			const text = readFileSync(new URL(url), "utf8");
			return { format: "module", source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
		}
		// src/mcp/server.ts imports `{ version }` from package.json, a named JSON import that
		// bundlers allow and Node does not.
		if (url.startsWith("file:") && url.endsWith("/package.json")) {
			const data = JSON.parse(readFileSync(new URL(url), "utf8")) as { version?: string };
			const source = `export const version = ${JSON.stringify(data.version)}; export default ${JSON.stringify(data)};`;
			return { format: "module", source, shortCircuit: true };
		}
		return nextLoad(url, context);
	},
});

const { buildServer } = await import("../src/mcp/server.ts");
const { createGtmClient } = await import("../src/gtm/client.ts");
const { DEFAULT_TOOL_GROUPS, TOOL_GROUP_NAMES, parseToolGroups } = await import("../src/tools/groups.ts");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");

type Groups = ReturnType<typeof parseToolGroups>;
interface Listed {
	body: string;
	tools: Array<{ name: string }>;
}

/** The tools/list response (one JSON-RPC message) for these groups. Tools are never called. */
async function listTools(groups: Groups): Promise<Listed> {
	const server = buildServer(
		{
			props: {
				email: "report@example.com",
				googleAccessToken: "",
				googleRefreshToken: "",
				googleExpiresAt: 0,
				googleScopes: [],
			},
			env: {} as Parameters<typeof buildServer>[0]["env"],
			gtm: createGtmClient({ getToken: () => "" }),
		},
		groups,
	);
	const [client, serverSide] = InMemoryTransport.createLinkedPair();
	const responses = new Map<number, string>();
	client.onmessage = (message) => {
		if ("id" in message && typeof message.id === "number") responses.set(message.id, JSON.stringify(message));
	};
	await server.connect(serverSide);
	await client.start();

	async function request(id: number, method: string, params: Record<string, unknown> = {}): Promise<string> {
		await client.send({ jsonrpc: "2.0", id, method, params });
		for (let i = 0; i < 100 && !responses.has(id); i++) await new Promise((r) => setTimeout(r, 10));
		const response = responses.get(id);
		if (!response) throw new Error(`No response to ${method}`);
		return response;
	}

	await request(1, "initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "tools-report", version: "0" },
	});
	await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
	const body = await request(2, "tools/list");
	await server.close();
	return { body, tools: (JSON.parse(body) as { result: { tools: Array<{ name: string }> } }).result.tools };
}

const bytesOf = (text: string) => Buffer.byteLength(text, "utf8");
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
const pct = (bytes: number) => `${((bytes / BUDGET_BYTES) * 100).toFixed(1)}%`;

const groupsArg = process.argv.find((a) => a.startsWith("--groups="))?.slice("--groups=".length);
let selected: Groups;
try {
	selected = parseToolGroups(groupsArg);
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}
const [chosen, all, core] = await Promise.all([
	listTools(selected),
	listTools(parseToolGroups("all")),
	listTools(new Set()),
]);

// Each tool's share: its own JSON plus the comma between array items.
const toolBytes = new Map(all.tools.map((t) => [t.name, bytesOf(JSON.stringify(t)) + 1]));
const coreNames = new Set(core.tools.map((t) => t.name));
const sum = (names: string[]) => names.reduce((n, name) => n + (toolBytes.get(name) ?? 0), 0);

console.log(`Tool groups (bytes = each tool's JSON in tools/list; ${kb(BUDGET_BYTES)} budget for the default groups)`);
console.log(`  ${"group".padEnd(16)} ${"default".padEnd(8)} ${"tools".padStart(5)} ${"bytes".padStart(7)}`);
const coreList = [...coreNames];
console.log(
	`  ${"(core)".padEnd(16)} ${"always".padEnd(8)} ${String(coreList.length).padStart(5)} ${String(sum(coreList)).padStart(7)}`,
);
const perGroup: Array<{ group: string; names: string[] }> = [];
for (const group of TOOL_GROUP_NAMES) {
	const { tools } = await listTools(new Set([group]));
	const names = tools.map((t) => t.name).filter((n) => !coreNames.has(n));
	perGroup.push({ group, names });
	const isDefault = (DEFAULT_TOOL_GROUPS as readonly string[]).includes(group) ? "yes" : "";
	const note = names.length === 0 ? "  (no tools yet)" : "";
	console.log(
		`  ${group.padEnd(16)} ${isDefault.padEnd(8)} ${String(names.length).padStart(5)} ${String(sum(names)).padStart(7)}${note}`,
	);
}

const chosenBytes = bytesOf(chosen.body);
const allBytes = bytesOf(all.body);
const label = groupsArg === undefined ? "default groups" : `GTM_TOOL_GROUPS=${groupsArg}`;
console.log("");
console.log(
	`${label}: ${chosen.tools.length} tools, ${chosenBytes} bytes (${kb(chosenBytes)}, ${pct(chosenBytes)} of budget)`,
);
console.log(`all groups: ${all.tools.length} tools, ${allBytes} bytes (${kb(allBytes)}, ${pct(allBytes)} of budget)`);

if (process.argv.includes("--tools")) {
	console.log("");
	for (const { group, names } of [{ group: "(core)", names: coreList }, ...perGroup]) {
		for (const name of names) console.log(`  ${String(toolBytes.get(name)).padStart(5)}  ${group.padEnd(16)} ${name}`);
	}
}
if (process.argv.includes("--json")) console.log(chosen.body);
if (groupsArg === undefined && chosenBytes >= BUDGET_BYTES) {
	console.error("Default groups over budget: trim descriptions or move a group to OPTIONAL_TOOL_GROUPS.");
	process.exitCode = 1;
}
