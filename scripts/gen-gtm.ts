// Generate src/gtm/generated.ts from Google's Tag Manager API v2 Discovery document.
//
//   node scripts/gen-gtm.ts                 fetch Discovery, write src/gtm/generated.ts
//   node scripts/gen-gtm.ts --check         regenerate in memory; exit 1 if the file is stale
//   node scripts/gen-gtm.ts --discovery f   read Discovery JSON from file f instead of fetching
//
// Runs on plain Node 24 (native type stripping), so this file uses only
// erasable TypeScript: no enums, namespaces or parameter properties, no imports
// of other .ts files. Output is deterministic: schemas, properties, resources,
// methods and query parameters are sorted by code unit, not locale.
//
// --check ignores the "Discovery revision" header line: Google bumps the
// revision almost daily without changing the API surface.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DISCOVERY_URL = "https://tagmanager.googleapis.com/$discovery/rest?version=v2";
const API_PREFIX = "tagmanager/v2/";
const OUT_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../src/gtm/generated.ts");
const REVISION_LINE = /^\/\/ Discovery revision: .*$/m;

interface DiscoveryProperty {
	type?: string;
	$ref?: string;
	format?: string;
	description?: string;
	enum?: string[];
	enumDescriptions?: string[];
	items?: DiscoveryProperty;
	additionalProperties?: DiscoveryProperty;
	properties?: Record<string, DiscoveryProperty>;
	deprecated?: boolean;
}

interface DiscoverySchema extends DiscoveryProperty {
	id?: string;
}

interface DiscoveryParameter extends DiscoveryProperty {
	location?: string;
	required?: boolean;
	repeated?: boolean;
	pattern?: string;
}

interface DiscoveryMethod {
	id: string;
	httpMethod: string;
	path: string;
	description?: string;
	parameters?: Record<string, DiscoveryParameter>;
	parameterOrder?: string[];
	request?: { $ref?: string };
	response?: { $ref?: string };
}

interface DiscoveryResource {
	methods?: Record<string, DiscoveryMethod>;
	resources?: Record<string, DiscoveryResource>;
}

interface DiscoveryDoc extends DiscoveryResource {
	revision?: string;
	rootUrl?: string;
	servicePath?: string;
	schemas?: Record<string, DiscoverySchema>;
}

interface CollectedMethod {
	/** Discovery resource names, e.g. ["accounts", "containers"]. */
	resourcePath: string[];
	name: string;
	method: DiscoveryMethod;
}

interface GenerateResult {
	code: string;
	revision: string;
	schemaCount: number;
	methodCount: number;
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function byCodeUnit(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function sortedEntries<T>(record: Record<string, T> | undefined): Array<[string, T]> {
	return Object.entries(record ?? {}).sort(([a], [b]) => byCodeUnit(a, b));
}

/** snake_case → camelCase ("move_entities_to_folder" → "moveEntitiesToFolder"). */
function camel(name: string): string {
	return name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

function isIdentifier(name: string): boolean {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

function propertyKey(name: string): string {
	return isIdentifier(name) ? name : JSON.stringify(name);
}

function lit(value: string): string {
	return JSON.stringify(value);
}

function fail(message: string): never {
	throw new Error(`gen-gtm: ${message}`);
}

/** JSDoc block from free-form lines; returns [] when there is nothing to say. */
function jsdoc(lines: readonly string[], indent: string): string[] {
	const body = lines.flatMap((l) => l.split(/\r?\n/)).map((l) => l.replace(/\s+$/, "").replace(/\*\//g, "*\\/"));
	while (body.length > 0 && body[0] === "") body.shift();
	while (body.length > 0 && body[body.length - 1] === "") body.pop();
	if (body.length === 0) return [];
	if (body.length === 1) return [`${indent}/** ${body[0]} */`];
	return [`${indent}/**`, ...body.map((l) => (l === "" ? `${indent} *` : `${indent} * ${l}`)), `${indent} */`];
}

function propertyDocLines(p: DiscoveryProperty): string[] {
	const lines: string[] = [];
	if (p.description) lines.push(p.description);
	if (p.format && p.type === "string") lines.push(`Format: ${p.format} (sent as a string).`);
	const enumValues = p.enum ?? p.items?.enum;
	const enumDescriptions = p.enum ? p.enumDescriptions : p.items?.enumDescriptions;
	if (enumValues && enumDescriptions?.some((d) => d.trim() !== "")) {
		lines.push("");
		enumValues.forEach((v, i) => {
			const d = enumDescriptions[i]?.trim();
			lines.push(d ? `- \`${v}\`: ${d}` : `- \`${v}\``);
		});
	}
	if (p.deprecated) lines.push("@deprecated");
	return lines;
}

function tsType(p: DiscoveryProperty, schemaNames: ReadonlySet<string>, where: string): string {
	if (p.$ref !== undefined) {
		if (!schemaNames.has(p.$ref)) fail(`${where}: unknown $ref ${p.$ref}`);
		return p.$ref;
	}
	switch (p.type) {
		case "string":
			return p.enum && p.enum.length > 0 ? p.enum.map(lit).join(" | ") : "string";
		case "integer":
		case "number":
			return "number";
		case "boolean":
			return "boolean";
		case "any":
			return "unknown";
		case "array": {
			if (!p.items) fail(`${where}: array without items`);
			const inner = tsType(p.items, schemaNames, `${where}[]`);
			return /[ |]/.test(inner) ? `(${inner})[]` : `${inner}[]`;
		}
		case "object": {
			if (p.additionalProperties) {
				return `Record<string, ${tsType(p.additionalProperties, schemaNames, `${where}{}`)}>`;
			}
			if (p.properties) {
				const fields = sortedEntries(p.properties).map(
					([k, v]) => `${propertyKey(k)}?: ${tsType(v, schemaNames, `${where}.${k}`)}`,
				);
				return `{ ${fields.join("; ")} }`;
			}
			return "Record<string, unknown>";
		}
		default:
			return fail(`${where}: unsupported type ${String(p.type)}`);
	}
}

function collectMethods(resource: DiscoveryResource, resourcePath: string[], out: CollectedMethod[]): void {
	for (const [name, method] of sortedEntries(resource.methods)) out.push({ resourcePath, name, method });
	for (const [name, child] of sortedEntries(resource.resources)) collectMethods(child, [...resourcePath, name], out);
}

function relativePath(m: DiscoveryMethod): string {
	if (!m.path.startsWith(API_PREFIX)) fail(`${m.id}: path ${m.path} does not start with ${API_PREFIX}`);
	return m.path.slice(API_PREFIX.length);
}

function pathParamNames(m: DiscoveryMethod): string[] {
	const params = sortedEntries(m.parameters).filter(([, p]) => p.location === "path");
	const order = m.parameterOrder ?? [];
	return params
		.map(([name]) => name)
		.sort((a, b) => {
			const ia = order.indexOf(a);
			const ib = order.indexOf(b);
			return ia !== ib ? (ia === -1 ? 1 : ib === -1 ? -1 : ia - ib) : byCodeUnit(a, b);
		});
}

function queryParamNames(m: DiscoveryMethod): string[] {
	return sortedEntries(m.parameters)
		.filter(([, p]) => p.location === "query")
		.map(([name]) => name);
}

function paramType(p: DiscoveryParameter, where: string): string {
	let base: string;
	if (p.type === "string") base = p.enum && p.enum.length > 0 ? p.enum.map(lit).join(" | ") : "string";
	else if (p.type === "boolean") base = "boolean";
	else if (p.type === "integer" || p.type === "number") base = "number";
	else return fail(`${where}: unsupported parameter type ${String(p.type)}`);
	if (!p.repeated) return base;
	return /[ |]/.test(base) ? `readonly (${base})[]` : `readonly ${base}[]`;
}

export function generate(doc: DiscoveryDoc, source: string): GenerateResult {
	const schemas = doc.schemas ?? fail("Discovery document has no schemas");
	if (!doc.resources) fail("Discovery document has no resources");
	const revision = doc.revision ?? "unknown";
	const schemaNames = new Set(Object.keys(schemas));
	const out: string[] = [];
	const push = (...lines: string[]) => {
		out.push(...lines);
	};

	const methods: CollectedMethod[] = [];
	collectMethods(doc, [], methods);

	push(
		"// GENERATED by scripts/gen-gtm.ts from the Tag Manager API v2 Discovery document. DO NOT EDIT.",
		"// Regenerate with `pnpm gen`; `pnpm gen:check` fails when this file is stale.",
		`// Source: ${source}`,
		`// Discovery revision: ${revision}`,
		`// ${schemaNames.size} schemas, ${methods.length} methods. Paths are relative to GTM_API_BASE_URL in ./client.`,
		"",
		'import { callMethod, type GtmRequester, type MethodDescriptor } from "./client";',
		"",
	);

	// ---- Schemas -----------------------------------------------------------
	for (const [name, schema] of sortedEntries(schemas)) {
		if (!isIdentifier(name)) fail(`schema name ${name} is not an identifier`);
		if (schema.type !== "object") fail(`schema ${name} has type ${String(schema.type)}`);
		push(...jsdoc(schema.description ? [schema.description] : [], ""));
		const props = sortedEntries(schema.properties);
		if (props.length === 0 && !schema.additionalProperties) {
			push(`export interface ${name} {}`, "");
			continue;
		}
		if (schema.additionalProperties) {
			push(`export type ${name} = ${tsType(schema, schemaNames, name)};`, "");
			continue;
		}
		push(`export interface ${name} {`);
		for (const [prop, p] of props) {
			push(...jsdoc(propertyDocLines(p), "\t"));
			push(`\t${propertyKey(prop)}?: ${tsType(p, schemaNames, `${name}.${prop}`)};`);
		}
		push("}", "");
	}

	push("/** Every schema name in the Discovery document. */");
	push(`export type SchemaName =`);
	const names = [...schemaNames].sort(byCodeUnit);
	names.forEach((n, i) => {
		push(`\t| ${lit(n)}${i === names.length - 1 ? ";" : ""}`);
	});
	push("");

	// ---- Methods table -----------------------------------------------------
	const keyOf = (m: CollectedMethod) => [...m.resourcePath, m.name].join(".");
	push(
		"/** Every Discovery method: verb, path template, parameters and request/response schema. */",
		"export const methods = {",
	);
	for (const cm of methods) {
		const m = cm.method;
		if (!HTTP_METHODS.has(m.httpMethod)) fail(`${m.id}: unsupported HTTP method ${m.httpMethod}`);
		const req = m.request?.$ref ?? null;
		const res = m.response?.$ref ?? null;
		if (req !== null && !schemaNames.has(req)) fail(`${m.id}: unknown request ${req}`);
		if (res !== null && !schemaNames.has(res)) fail(`${m.id}: unknown response ${res}`);
		const pathParams = pathParamNames(m).map((n) => {
			const pattern = m.parameters?.[n]?.pattern;
			return `${propertyKey(n)}: ${pattern === undefined ? lit("^.+$") : lit(pattern)}`;
		});
		push(
			`\t${lit(keyOf(cm))}: {`,
			`\t\tid: ${lit(m.id)},`,
			`\t\thttpMethod: ${lit(m.httpMethod)},`,
			`\t\tpath: ${lit(relativePath(m))},`,
			`\t\tpathParams: { ${pathParams.join(", ")} },`,
			`\t\tqueryParams: [${queryParamNames(m).map(lit).join(", ")}],`,
			`\t\trequest: ${req === null ? "null" : lit(req)},`,
			`\t\tresponse: ${res === null ? "null" : lit(res)},`,
			"\t},",
		);
	}
	push("} as const satisfies Record<string, MethodDescriptor>;", "");
	push("export type MethodKey = keyof typeof methods;", "");

	// ---- Typed wrappers, grouped by resource -------------------------------
	interface Node {
		methods: CollectedMethod[];
		children: Map<string, Node>;
	}
	const root: Node = { methods: [], children: new Map() };
	for (const cm of methods) {
		let node = root;
		for (const r of cm.resourcePath) {
			let child = node.children.get(r);
			if (!child) {
				child = { methods: [], children: new Map() };
				node.children.set(r, child);
			}
			node = child;
		}
		node.methods.push(cm);
	}
	if (root.methods.length > 0) fail("top-level methods are not supported");

	const emitMethod = (cm: CollectedMethod, indent: string): void => {
		const m = cm.method;
		const req = m.request?.$ref;
		const res = m.response?.$ref;
		const pathNames = pathParamNames(m);
		const queryNames = queryParamNames(m);
		const allOptional = pathNames.length === 0 && queryNames.every((q) => !m.parameters?.[q]?.required);
		const fields: string[] = [];
		for (const n of [...pathNames, ...queryNames]) {
			const p = m.parameters?.[n] ?? fail(`${m.id}: missing parameter ${n}`);
			const required = p.location === "path" || p.required === true;
			fields.push(...jsdoc(propertyDocLines(p), `${indent}\t\t`));
			fields.push(`${indent}\t\t${propertyKey(n)}${required ? "" : "?"}: ${paramType(p, `${m.id}.${n}`)};`);
		}
		push(...jsdoc([...(m.description ? [m.description] : []), "", `\`${m.httpMethod} ${relativePath(m)}\``], indent));
		const fn = camel(cm.name);
		push(`${indent}${propertyKey(fn)}(`, `${indent}\tclient: GtmRequester,`);
		if (fields.length === 0) push(`${indent}\tparams: Record<string, never> = {},`);
		else push(`${indent}\tparams: {`, ...fields, `${indent}\t}${allOptional ? " = {}" : ""},`);
		if (req) push(`${indent}\tbody: ${req},`);
		const ret = res ?? "void";
		push(`${indent}): Promise<${ret}> {`);
		push(
			`${indent}\treturn callMethod<${ret}>(client, methods[${lit(keyOf(cm))}], params${req ? ", body" : ""});`,
			`${indent}},`,
		);
	};

	const emitNode = (node: Node, indent: string): void => {
		const seen = new Set<string>();
		const claim = (name: string, what: string) => {
			if (seen.has(name)) fail(`name collision on ${name} (${what})`);
			seen.add(name);
		};
		for (const cm of node.methods) {
			claim(camel(cm.name), cm.method.id);
			emitMethod(cm, indent);
		}
		for (const [name, child] of [...node.children.entries()].sort(([a], [b]) => byCodeUnit(a, b))) {
			claim(camel(name), name);
			push(`${indent}${propertyKey(camel(name))}: {`);
			emitNode(child, `${indent}\t`);
			push(`${indent}},`);
		}
	};

	for (const [name, child] of [...root.children.entries()].sort(([a], [b]) => byCodeUnit(a, b))) {
		const id = camel(name);
		if (!isIdentifier(id)) fail(`resource ${name} is not an identifier`);
		push(`/** Typed wrappers for the \`${name}\` resource tree. */`, `export const ${id} = {`);
		emitNode(child, "\t");
		push("};", "");
	}

	return {
		code: `${out.join("\n").replace(/\n+$/, "")}\n`,
		revision,
		schemaCount: schemaNames.size,
		methodCount: methods.length,
	};
}

async function loadDiscovery(file: string | undefined): Promise<DiscoveryDoc> {
	if (file) return JSON.parse(await readFile(file, "utf8")) as DiscoveryDoc;
	const res = await fetch(DISCOVERY_URL);
	if (!res.ok) fail(`fetching ${DISCOVERY_URL} returned HTTP ${res.status}`);
	return (await res.json()) as DiscoveryDoc;
}

function withoutRevision(code: string): string {
	return code.replace(/\r\n/g, "\n").replace(REVISION_LINE, "// Discovery revision: <ignored>");
}

async function main(argv: readonly string[]): Promise<number> {
	const check = argv.includes("--check");
	const i = argv.indexOf("--discovery");
	const discoveryFile = i === -1 ? undefined : argv[i + 1];
	if (i !== -1 && !discoveryFile) fail("--discovery needs a file path");

	const doc = await loadDiscovery(discoveryFile);
	const result = generate(doc, DISCOVERY_URL);

	if (!check) {
		await writeFile(OUT_FILE, result.code, "utf8");
		console.log(
			`Wrote ${OUT_FILE} (revision ${result.revision}, ${result.schemaCount} schemas, ${result.methodCount} methods).`,
		);
		return 0;
	}

	let existing: string;
	try {
		existing = await readFile(OUT_FILE, "utf8");
	} catch {
		console.error(`${OUT_FILE} does not exist. Run \`pnpm gen\`.`);
		return 1;
	}
	const a = withoutRevision(existing).split("\n");
	const b = withoutRevision(result.code).split("\n");
	const firstDiff = a.findIndex((line, n) => line !== b[n]);
	if (firstDiff === -1 && a.length === b.length) {
		const old = REVISION_LINE.exec(existing.replace(/\r\n/g, "\n"))?.[0] ?? "";
		const note = old.endsWith(result.revision)
			? ""
			: ` (Discovery revision is now ${result.revision}; surface unchanged)`;
		console.log(`generated.ts is up to date${note}.`);
		return 0;
	}
	const line = firstDiff === -1 ? Math.min(a.length, b.length) : firstDiff;
	console.error(`generated.ts is stale (revision ${result.revision}). First difference at line ${line + 1}:`);
	console.error(`  file:      ${a[line] ?? "<end of file>"}`);
	console.error(`  generated: ${b[line] ?? "<end of file>"}`);
	console.error("Run `pnpm gen` and review the diff.");
	return 1;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	main(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(error: unknown) => {
			console.error(error instanceof Error ? error.message : error);
			process.exitCode = 2;
		},
	);
}
