// Thin fetch wrapper for the Tag Manager API v2.
//
// - request(): bearer auth, JSON in/out, retry with 1s/2s/4s backoff on 429,
//   403 rate-limit reasons, and 5xx for GET only (a write may have been applied
//   before a 5xx, Q16). Never retries 400/401/404/409/412.
// - listAll(): follows nextPageToken, capped (default 20 pages).
// - callMethod(): used by the generated wrappers in generated.ts to expand a
//   Discovery path template and pick query parameters.
//
// The client never logs, and error messages never include the token.

import { GtmApiError, MESSAGES, toGtmApiError } from "./errors";

export const GTM_API_BASE_URL = "https://tagmanager.googleapis.com/tagmanager/v2/";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A query value. Arrays become repeated keys (`tagId=1&tagId=2`); undefined/null are skipped. */
export type QueryValue = string | number | boolean | readonly string[] | null | undefined;
export type Query = Readonly<Record<string, QueryValue>>;

export interface RequestOptions {
	query?: Query;
	/** Serialised as JSON. Leave undefined for no body. */
	body?: unknown;
}

/** The minimal surface the generated wrappers need. Easy to fake in tests. */
export interface GtmRequester {
	request<T>(method: HttpMethod, path: string, options?: RequestOptions): Promise<T>;
}

export interface ListAllOptions {
	/** Stop after this many pages (default {@link DEFAULT_MAX_PAGES}). */
	maxPages?: number;
}

export interface ListAllResult<T> {
	items: T[];
	pages: number;
	/** True when the page cap was hit and Google still had more pages. */
	truncated: boolean;
	/** The token for the next page when truncated. */
	nextPageToken?: string;
}

export interface GtmClient extends GtmRequester {
	listAll<P extends { nextPageToken?: string }, T>(
		fetchPage: (pageToken: string | undefined) => Promise<P>,
		pick: (page: P) => readonly T[] | undefined,
		options?: ListAllOptions,
	): Promise<ListAllResult<T>>;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface GtmClientOptions {
	/** Returns the Google access token. Called once per request() call (not per retry). */
	getToken: () => string | Promise<string>;
	/** Defaults to the global fetch. */
	fetch?: FetchLike;
	/** Defaults to setTimeout. Inject a no-op in tests. */
	sleep?: (ms: number) => Promise<void>;
	/** Defaults to {@link GTM_API_BASE_URL}. Must end with "/". */
	baseUrl?: string;
	/** Defaults to {@link MAX_RETRIES}. */
	maxRetries?: number;
}

export const MAX_RETRIES = 3;
export const BACKOFF_MS: readonly number[] = [1000, 2000, 4000];
export const DEFAULT_MAX_PAGES = 20;

/**
 * List pages one tool call (or prompt) may read when it lists several things at once: a
 * skill's live data, or the reference checks of delete_trigger / delete_variable /
 * delete_template. Each page is a subrequest, and a Worker gets 50 per request on the Free
 * plan; this leaves room for the reads and writes around the lists, a token refresh and
 * retries. Results that hit it say so (`truncated`).
 */
export const LIST_PAGE_BUDGET = 24;

/** `maxPages` for each of `lists` lists read for one call, so together they stay in LIST_PAGE_BUDGET. */
export function pagesPerList(lists: number): ListAllOptions {
	return { maxPages: Math.max(1, Math.floor(LIST_PAGE_BUDGET / Math.max(1, lists))) };
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Append query parameters. Arrays repeat the key; booleans become "true"/"false". */
export function encodeQuery(url: URL, query: Query | undefined): void {
	if (!query) return;
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null) continue;
		if (Array.isArray(value)) {
			for (const v of value) url.searchParams.append(key, v);
		} else {
			url.searchParams.append(key, String(value));
		}
	}
}

/**
 * Resolve an API-relative path ("accounts/1/containers") against the base URL.
 * Rejects absolute URLs, leading slashes and dot segments so a crafted path
 * can never send the bearer token to another host or API.
 */
export function resolveApiUrl(baseUrl: string, path: string): URL {
	if (path === "" || path.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.includes("\\")) {
		throw new TypeError(`Invalid GTM API path: ${JSON.stringify(path)}`);
	}
	const pathOnly = path.split(/[?#]/, 1)[0] ?? "";
	if (pathOnly.split("/").some((s) => s === "" || s === "." || s === ".." || /^%2e(%2e)?$/i.test(s))) {
		throw new TypeError(`Invalid GTM API path: ${JSON.stringify(path)}`);
	}
	const url = new URL(path, baseUrl);
	if (!url.href.startsWith(baseUrl)) throw new TypeError(`Invalid GTM API path: ${JSON.stringify(path)}`);
	return url;
}

function parseJson(text: string): unknown {
	return JSON.parse(text);
}

/** Follow nextPageToken until done or the page cap is hit. */
export async function listAll<P extends { nextPageToken?: string }, T>(
	fetchPage: (pageToken: string | undefined) => Promise<P>,
	pick: (page: P) => readonly T[] | undefined,
	options: ListAllOptions = {},
): Promise<ListAllResult<T>> {
	const maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES);
	const items: T[] = [];
	const seen = new Set<string>();
	let token: string | undefined;
	let pages = 0;
	while (pages < maxPages) {
		const page = await fetchPage(token);
		pages++;
		items.push(...(pick(page) ?? []));
		const next = page.nextPageToken;
		// Stop on a missing token, or one we've already used (defends against a server loop).
		if (!next || seen.has(next)) return { items, pages, truncated: false };
		seen.add(next);
		token = next;
	}
	return { items, pages, truncated: true, nextPageToken: token };
}

export function createGtmClient(options: GtmClientOptions): GtmClient {
	const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
	const sleep = options.sleep ?? defaultSleep;
	const baseUrl = options.baseUrl ?? GTM_API_BASE_URL;
	const maxRetries = options.maxRetries ?? MAX_RETRIES;

	async function request<T>(method: HttpMethod, path: string, opts: RequestOptions = {}): Promise<T> {
		const url = resolveApiUrl(baseUrl, path);
		encodeQuery(url, opts.query);
		const token = await options.getToken();
		const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
		let body: string | undefined;
		if (opts.body !== undefined) {
			headers["Content-Type"] = "application/json";
			body = JSON.stringify(opts.body);
		}
		const init: RequestInit = body === undefined ? { method, headers } : { method, headers, body };
		const label = `${url.pathname.replace(/^\/tagmanager\/v2\//, "")}${url.search}`;

		for (let attempt = 0; ; attempt++) {
			let res: Response;
			try {
				res = await fetchImpl(url.href, init);
			} catch (cause) {
				throw new GtmApiError(MESSAGES.network, { status: 0, kind: "network", method, path: label, cause });
			}

			const text = await res.text();
			if (res.ok) {
				if (text.trim() === "") return undefined as T;
				try {
					return parseJson(text) as T;
				} catch (cause) {
					throw new GtmApiError(MESSAGES.invalidResponse, {
						status: res.status,
						kind: "invalidResponse",
						method,
						path: label,
						cause,
					});
				}
			}

			let parsed: unknown;
			try {
				parsed = text ? parseJson(text) : undefined;
			} catch {
				parsed = undefined;
			}
			const error = toGtmApiError({ status: res.status, method, path: label, body: parsed, rawText: text });
			if (error.retryable && attempt < maxRetries) {
				await sleep(BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1] ?? 4000);
				continue;
			}
			throw error;
		}
	}

	return { request, listAll };
}

/** One row of the generated `methods` table. */
export interface MethodDescriptor {
	/** Discovery method id, e.g. "tagmanager.accounts.containers.workspaces.tags.update". */
	readonly id: string;
	readonly httpMethod: HttpMethod;
	/** Path template relative to {@link GTM_API_BASE_URL}, e.g. "{+path}:sync". */
	readonly path: string;
	/** Path parameter name → validation regex from Discovery. */
	readonly pathParams: Readonly<Record<string, string>>;
	readonly queryParams: readonly string[];
	/** Request schema name, or null when the method takes no body. */
	readonly request: string | null;
	/** Response schema name, or null when the method returns an empty body. */
	readonly response: string | null;
}

/**
 * Expand a Discovery path template. `{+name}` keeps "/" (reserved expansion)
 * but every segment is still percent-encoded and must match the Discovery
 * pattern, so IDs can't smuggle in "..", "?" or "#".
 */
export function expandPath(method: MethodDescriptor, params: Readonly<Record<string, QueryValue>>): string {
	return method.path.replace(/\{(\+?)([A-Za-z0-9_]+)\}/g, (_match, plus: string, name: string) => {
		const value = params[name];
		if (typeof value !== "string" || value === "") {
			throw new TypeError(`${method.id}: missing path parameter "${name}"`);
		}
		const pattern = method.pathParams[name];
		if (pattern !== undefined && !new RegExp(pattern).test(value)) {
			throw new TypeError(`${method.id}: "${name}" has the wrong shape: ${JSON.stringify(value)}`);
		}
		const segments = plus ? value.split("/") : [value];
		if (segments.some((s) => s === "" || s === "." || s === "..")) {
			throw new TypeError(`${method.id}: "${name}" has an empty or dot segment: ${JSON.stringify(value)}`);
		}
		return segments.map(encodeURIComponent).join("/");
	});
}

/** Run one Discovery method. Used by the generated wrappers. */
export function callMethod<T>(
	client: GtmRequester,
	method: MethodDescriptor,
	params: Readonly<Record<string, QueryValue>>,
	body?: unknown,
): Promise<T> {
	let path: string;
	try {
		path = expandPath(method, params);
	} catch (error) {
		return Promise.reject(error);
	}
	const query: Record<string, QueryValue> = {};
	for (const name of method.queryParams) {
		const value = params[name];
		if (value !== undefined && value !== null) query[name] = value;
	}
	const options: RequestOptions = {};
	if (Object.keys(query).length > 0) options.query = query;
	if (method.request !== null && body !== undefined) options.body = body;
	return client.request<T>(method.httpMethod, path, options);
}
