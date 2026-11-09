// Print the tool count and the byte size of the tools/list response. Budget: < 40 KB.
//
//   pnpm tools-report          (= node scripts/tools-report.ts)
//   node scripts/tools-report.ts --json    also print the full tools/list JSON
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
const { InMemoryTransport } = await import("@modelcontextprotocol/server");

// Tools are only listed, never called: no real props, env or token needed.
const server = buildServer({
	props: {
		email: "report@example.com",
		googleAccessToken: "",
		googleRefreshToken: "",
		googleExpiresAt: 0,
		googleScopes: [],
	},
	env: {} as Parameters<typeof buildServer>[0]["env"],
	gtm: createGtmClient({ getToken: () => "" }),
});

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

const tools = (JSON.parse(body) as { result: { tools: Array<{ name: string }> } }).result.tools;
const bytes = Buffer.byteLength(body, "utf8");
const pct = ((bytes / BUDGET_BYTES) * 100).toFixed(1);

console.log(`tools: ${tools.length}`);
console.log(`tools/list response: ${bytes} bytes (${(bytes / 1024).toFixed(1)} KB, ${pct}% of the 40 KB budget)`);
for (const t of tools) console.log(`  ${t.name}`);
if (process.argv.includes("--json")) console.log(body);
if (bytes >= BUDGET_BYTES) {
	console.error("Over budget: trim descriptions or split tool groups.");
	process.exitCode = 1;
}
