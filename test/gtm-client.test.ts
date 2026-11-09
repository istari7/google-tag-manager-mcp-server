import { describe, expect, it, vi } from "vitest";
import {
	BACKOFF_MS,
	callMethod,
	createGtmClient,
	DEFAULT_MAX_PAGES,
	encodeQuery,
	GTM_API_BASE_URL,
	listAll,
	MAX_RETRIES,
	resolveApiUrl,
	withoutRetries,
} from "../src/gtm/client";
import { GtmApiError, MESSAGES, notFoundHint, toGtmApiError } from "../src/gtm/errors";
import { accounts, methods, type Tag } from "../src/gtm/generated";
import {
	accountPath,
	assertGtmId,
	builtInVariablesPath,
	containerPath,
	folderPath,
	InvalidGtmIdError,
	isPublicContainerId,
	parseGtmPath,
	tagPath,
	triggerPath,
	variablePath,
	versionPath,
	workspacePath,
} from "../src/gtm/paths";
import { json, type Reply, TEST_TOKEN, testClient } from "./fixtures/fake-fetch";
import { errors, FOLDER_PATH, ga4EventTag, TAG_PATH, TRIGGER_PATH, VARIABLE_PATH, WORKSPACE } from "./fixtures/gtm";

const ws = accounts.containers.workspaces;

async function caught(promise: Promise<unknown>): Promise<GtmApiError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof GtmApiError) return error;
		throw error;
	}
	throw new Error("expected a GtmApiError");
}

describe("request basics", () => {
	it("sends the bearer token and JSON headers to the v2 base URL", async () => {
		const { client, calls } = testClient([json(200, { account: [] })]);
		await accounts.list(client);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.url.href).toBe(`${GTM_API_BASE_URL}accounts`);
		expect(calls[0]?.headers.authorization).toBe(`Bearer ${TEST_TOKEN}`);
		expect(calls[0]?.headers.accept).toBe("application/json");
		expect(calls[0]?.headers["content-type"]).toBeUndefined();
	});

	it("serialises the body as JSON with a content type", async () => {
		const { client, calls } = testClient([json(200, { tagId: "99" })]);
		await ws.tags.create(client, { parent: WORKSPACE }, { name: "x", type: "html" });
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.url.pathname).toBe(`/tagmanager/v2/${WORKSPACE}/tags`);
		expect(calls[0]?.headers["content-type"]).toBe("application/json");
		expect(calls[0]?.body).toEqual({ name: "x", type: "html" });
	});

	it("returns undefined for an empty 204 response", async () => {
		const { client } = testClient([json(204)]);
		await expect(ws.tags.delete(client, { path: TAG_PATH })).resolves.toBeUndefined();
	});

	it("asks for the token once per request, not once per retry", async () => {
		const { client, tokenCalls } = testClient([json(503, errors.backend503), json(200, {})]);
		await client.request("GET", "accounts");
		expect(tokenCalls()).toBe(1);
	});

	it("accepts an async getToken and the default sleep is never used when injected", async () => {
		const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
		const client = createGtmClient({ getToken: async () => "t", fetch, sleep: async () => {} });
		await client.request("GET", "accounts");
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("wraps a network failure without retrying it", async () => {
		const { client, calls } = testClient([new TypeError("connection reset")]);
		const error = await caught(client.request("GET", "accounts"));
		expect(error.kind).toBe("network");
		expect(error.status).toBe(0);
		expect(error.message).toBe(MESSAGES.network);
		expect(calls).toHaveLength(1);
	});

	it("reports an unreadable 2xx body", async () => {
		const { client } = testClient([{ status: 200, text: "<html>oops" }]);
		const error = await caught(client.request("GET", "accounts"));
		expect(error.kind).toBe("invalidResponse");
	});
});

describe("retry rules", () => {
	const retried: Array<[string, Reply]> = [
		["429", json(429, errors.tooMany429)],
		["403 rateLimitExceeded", json(403, errors.rateLimit403)],
		["403 userRateLimitExceeded", json(403, errors.userRateLimit403)],
		["500", json(500, { error: { code: 500, message: "Internal error encountered." } })],
		["503", json(503, errors.backend503)],
	];

	for (const [name, reply] of retried) {
		it(`retries ${name} with 1s/2s/4s backoff, then succeeds`, async () => {
			const { client, calls, sleeps } = testClient([reply, reply, reply, json(200, { ok: true })]);
			await expect(client.request("GET", "accounts")).resolves.toEqual({ ok: true });
			expect(calls).toHaveLength(4);
			expect(sleeps).toEqual([1000, 2000, 4000]);
		});
	}

	it("gives up after 3 retries and throws the last error", async () => {
		const { client, calls, sleeps } = testClient([json(429, errors.tooMany429)]);
		const error = await caught(client.request("GET", "accounts"));
		expect(calls).toHaveLength(1 + MAX_RETRIES);
		expect(sleeps).toEqual([...BACKOFF_MS]);
		expect(error.status).toBe(429);
		expect(error.message).toBe(MESSAGES.rateLimit);
	});

	// Q16: for writes, retry only what Google did not process: 429 and 403 rate limits.
	for (const method of ["POST", "PUT", "DELETE"] as const) {
		for (const [name, reply] of retried.slice(0, 3)) {
			it(`Q16 a ${method} retries ${name} (Google did not process it)`, async () => {
				const { client, calls, sleeps } = testClient([reply, json(200, { ok: true })]);
				await expect(client.request(method, "accounts/1/containers/2/workspaces/3/tags")).resolves.toEqual({
					ok: true,
				});
				expect(calls).toHaveLength(2);
				expect(sleeps).toEqual([1000]);
			});
		}
		for (const status of [500, 502, 503] as const) {
			it(`Q16 a ${method} is not retried on ${status}: the write may have been applied`, async () => {
				const { client, calls, sleeps } = testClient([json(status, errors.backend503), json(200, { ok: true })]);
				const error = await caught(client.request(method, "accounts/1/containers/2/workspaces/3/tags"));
				expect(calls).toHaveLength(1);
				expect(sleeps).toEqual([]);
				expect(error.status).toBe(status);
				expect(error.retryable).toBe(false);
				expect(error.message).toMatch(/may or may not have been applied/);
				expect(error.message).toMatch(/[Rr]e-read/);
			});
		}
	}

	it("resends the same method, URL and body on retry", async () => {
		const { client, calls } = testClient([json(429, errors.tooMany429), json(200, ga4EventTag)]);
		await ws.tags.update(client, { path: TAG_PATH, fingerprint: "fp" }, { name: "n" });
		expect(calls).toHaveLength(2);
		expect(calls[1]?.method).toBe(calls[0]?.method);
		expect(calls[1]?.url.href).toBe(calls[0]?.url.href);
		expect(calls[1]?.body).toEqual(calls[0]?.body);
	});

	const neverRetried: Array<[number, Reply]> = [
		[400, json(400, errors.duplicateName400)],
		[401, json(401, errors.unauthenticated401)],
		[403, json(403, errors.forbidden403)],
		[404, json(404, errors.notFound404)],
		[409, json(409, errors.fingerprint409)],
		[412, json(412, errors.precondition412)],
	];

	for (const [status, reply] of neverRetried) {
		it(`never retries ${status}`, async () => {
			const { client, calls, sleeps } = testClient([reply, json(200, {})]);
			const error = await caught(client.request("GET", "accounts"));
			expect(error.status).toBe(status);
			expect(calls).toHaveLength(1);
			expect(sleeps).toEqual([]);
		});
	}

	it("does not retry a daily-quota 403 (waiting seconds won't help)", async () => {
		const { client, calls } = testClient([json(403, errors.quota403)]);
		const error = await caught(client.request("GET", "accounts"));
		expect(error.kind).toBe("quota");
		expect(calls).toHaveLength(1);
	});
});

describe("error mapping", () => {
	const map = (status: number, body: unknown, path = "accounts/1/containers/2") =>
		toGtmApiError({ status, method: "GET", path, body });

	it("401 → reconnect message", () => {
		const e = map(401, errors.unauthenticated401);
		expect(e.kind).toBe("auth");
		expect(e.message).toBe("Google session expired. Reconnect the GTM connector.");
	});

	it("403 → no permission for the resource; drops Google's generic message", () => {
		const e = map(403, errors.forbidden403);
		expect(e.kind).toBe("permission");
		expect(e.message).toBe("No permission for accounts/1/containers/2. Check the Google account has access.");
		expect(e.reason).toBe("forbidden");
	});

	it("403 rate limit → rate limit message", () => {
		expect(map(403, errors.userRateLimit403).message).toBe(MESSAGES.rateLimit);
	});

	it("403 API disabled → enable-the-API message that keeps Google's console link", () => {
		const e = map(403, errors.apiDisabled403);
		expect(e.kind).toBe("apiDisabled");
		expect(e.message).toContain(MESSAGES.apiDisabled);
		expect(e.message).toContain("https://console.developers.google.com/apis/api/tagmanager.googleapis.com");
	});

	it("403 insufficient scopes → reconnect-and-approve message", () => {
		const e = map(403, errors.scope403);
		expect(e.kind).toBe("scope");
		expect(e.message).toBe(MESSAGES.scope);
	});

	it("404 → not found with the path; generic 'Not Found' is dropped", () => {
		const e = map(404, errors.notFound404, `${TAG_PATH}?fingerprint=1`);
		expect(e.message).toBe(`Not found: ${TAG_PATH}. Check the tag ID, then the account/container/workspace IDs.`);
	});

	it.each([
		["accounts/1", "Check the account ID."],
		["accounts/1/containers/2/versions/999", "Check the version ID, then the account/container IDs."],
		["accounts/1/containers/2/versions/999:publish", "Check the version ID, then the account/container IDs."],
		[
			"accounts/1/containers/2/workspaces/3/folders/4",
			"Check the folder ID, then the account/container/workspace IDs.",
		],
		[
			"accounts/1/containers/2/workspaces/3/gtag_config/4",
			"Check the Google tag config ID, then the account/container/workspace IDs.",
		],
		["accounts/1/user_permissions/5", "Check the user permission ID, then the account ID."],
		["accounts/containers:lookup", "Check the IDs in this path."],
	])("404 on %s names the IDs in that path", (path, hint) => {
		expect(notFoundHint(path)).toBe(hint);
		expect(map(404, errors.notFound404, path).message).toBe(`Not found: ${path}. ${hint}`);
	});

	it("Q38 a zone 404 adds that zones need GTM 360 (Google answers 404 on standard accounts)", () => {
		const path = "accounts/1/containers/2/workspaces/3/zones";
		const e = map(404, { error: { code: 404, message: "Not found or permission denied." } }, path);
		expect(e.message).toBe(
			`Not found: ${path}. Check the workspace ID, then the account/container IDs. Google says: Not found or permission denied. Zones exist only in GTM 360 accounts: on a standard account Google answers 404 here even when every ID is right.`,
		);
	});

	it("Q38 a user-permission 404 'User not found' says the email has no Google account, not that an ID is wrong", () => {
		const path = "accounts/1/user_permissions";
		const e = map(404, { error: { code: 404, message: "User not found" } }, path);
		expect(e.kind).toBe("notFound");
		expect(e.message).toContain("no Google account for that email address");
		expect(e.message).not.toContain("Check the account ID");
	});

	it("Q31 a 429 shows Google's text when it says more than rate limit", () => {
		const e = map(429, { error: { code: 429, message: "A Google tag config of this type already exists." } });
		expect(e.message).toBe(`${MESSAGES.rateLimit} Google says: A Google tag config of this type already exists.`);
	});

	it("Q31 withoutRetries sends a 429 once", async () => {
		const { client, calls } = testClient([json(429, errors.tooMany429)]);
		const error = await caught(ws.gtagConfig.create(withoutRetries(client), { parent: WORKSPACE }, { type: "x" }));
		expect(error.status).toBe(429);
		expect(calls).toHaveLength(1);
	});

	it("409 and 412 → changed since it was read", () => {
		expect(map(409, errors.fingerprint409).message).toBe(MESSAGES.conflict);
		expect(map(412, errors.precondition412).message).toBe(MESSAGES.conflict);
	});

	it("409 keeps Google's message when it says something new", () => {
		const e = map(409, { error: { code: 409, message: "Workspace has been synced; entity was deleted upstream." } });
		expect(e.message).toBe(`${MESSAGES.conflict} Google says: Workspace has been synced; entity was deleted upstream.`);
	});

	it("429 → rate limit message", () => {
		expect(map(429, errors.tooMany429).message).toBe("GTM API rate limit hit. Wait a minute and retry.");
	});

	it("400 keeps Google's message once, even when errors[] repeats it", () => {
		const e = map(400, errors.duplicateName400);
		expect(e.kind).toBe("invalid");
		expect(e.message).toBe("GTM rejected the request: Found entity with duplicate name: GA4 - Event - sign_up");
	});

	it("keeps distinct messages from errors[]", () => {
		const e = map(400, {
			error: { code: 400, message: "Invalid tag", errors: [{ message: "Parameter 'eventName' is required" }] },
		});
		expect(e.message).toBe("GTM rejected the request: Invalid tag / Parameter 'eventName' is required");
	});

	it("5xx → temporary message, generic Google text dropped", () => {
		expect(map(503, errors.backend503).message).toBe(
			"The GTM API is temporarily unavailable (HTTP 503). Retry in a minute.",
		);
	});

	it("Q16 5xx on a write → the write may or may not have been applied; re-read before retrying", () => {
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
			const e = toGtmApiError({ status: 503, method, path: TAG_PATH, body: errors.backend503 });
			expect(e.kind).toBe("server");
			expect(e.retryable).toBe(false);
			expect(e.message).toBe(
				`The GTM API failed (HTTP 503) during a ${method} to ${TAG_PATH}. The write may or may not have been applied: re-read the affected entity (get_* or list_*) before retrying, so a retry doesn't create a duplicate or report a false conflict.`,
			);
		}
	});

	it("falls back to a plain-text body only when there is no structured error, and never to HTML", () => {
		const text = toGtmApiError({
			status: 502,
			method: "GET",
			path: "accounts",
			body: undefined,
			rawText: "upstream proxy failure",
		});
		expect(text.message).toContain("Google says: upstream proxy failure");
		const html = toGtmApiError({
			status: 502,
			method: "GET",
			path: "accounts",
			body: undefined,
			rawText: "<html>Bad gateway</html>",
		});
		expect(html.message).not.toContain("<html>");
	});

	it("surfaces mapped errors from request() with method and path, never the token", async () => {
		const { client } = testClient([json(404, errors.notFound404)]);
		const e = await caught(ws.tags.get(client, { path: TAG_PATH }));
		expect(e).toBeInstanceOf(GtmApiError);
		expect(e.method).toBe("GET");
		expect(e.path).toBe(TAG_PATH);
		expect(`${e.message} ${JSON.stringify(e)}`).not.toContain(TEST_TOKEN);
	});

	it("builds a local conflict for a stale expected fingerprint", () => {
		const e = GtmApiError.conflict("PUT", TAG_PATH);
		expect(e.status).toBe(409);
		expect(e.retryable).toBe(false);
	});
});

describe("query and path encoding", () => {
	it("Q2: tags.update sends the fingerprint as a query parameter, not in the body", async () => {
		const { client, calls } = testClient([json(200, ga4EventTag)]);
		await ws.tags.update(client, { path: TAG_PATH, fingerprint: "1731100000001" }, { name: "Renamed" });
		const call = calls[0];
		expect(call?.method).toBe("PUT");
		expect(call?.url.pathname).toBe(`/tagmanager/v2/${TAG_PATH}`);
		expect(call?.url.searchParams.get("fingerprint")).toBe("1731100000001");
		expect(call?.body).toEqual({ name: "Renamed" });
	});

	it("omits an undefined fingerprint entirely", async () => {
		const { client, calls } = testClient([json(200, ga4EventTag)]);
		await ws.tags.update(client, { path: TAG_PATH, fingerprint: undefined }, {});
		expect(calls[0]?.url.search).toBe("");
	});

	it("Q19: move_entities_to_folder repeats tagId/triggerId/variableId query keys", async () => {
		const { client, calls } = testClient([json(200)]);
		await ws.folders.moveEntitiesToFolder(
			client,
			{ path: FOLDER_PATH, tagId: ["1", "2"], triggerId: ["3"], variableId: [] },
			{},
		);
		const url = calls[0]?.url;
		expect(url?.pathname).toBe(`/tagmanager/v2/${FOLDER_PATH}:move_entities_to_folder`);
		expect(url?.searchParams.getAll("tagId")).toEqual(["1", "2"]);
		expect(url?.searchParams.getAll("triggerId")).toEqual(["3"]);
		expect(url?.searchParams.has("variableId")).toBe(false);
	});

	it("encodes booleans and skips null/undefined", () => {
		const url = new URL(GTM_API_BASE_URL);
		encodeQuery(url, { includeGoogleTags: true, a: undefined, b: null, n: 3 });
		expect(url.search).toBe("?includeGoogleTags=true&n=3");
	});

	it("Q21: custom verbs keep '/' in {+path} and append ':verb'", async () => {
		const { client, calls } = testClient([json(200, {})]);
		await ws.sync(client, { path: WORKSPACE });
		expect(calls[0]?.url.pathname).toBe(`/tagmanager/v2/${WORKSPACE}:sync`);
	});

	it("Q21: wrappers reject a path that doesn't match the Discovery pattern", async () => {
		const { client, calls } = testClient([json(200, {})]);
		await expect(ws.tags.get(client, { path: WORKSPACE })).rejects.toThrow(/wrong shape/);
		await expect(ws.tags.get(client, { path: `${WORKSPACE}/tags/../../x` })).rejects.toThrow();
		expect(calls).toHaveLength(0);
	});

	it("percent-encodes odd characters inside a segment instead of letting them reshape the URL", async () => {
		const { client, calls } = testClient([json(200, {})]);
		await callMethod(client, methods["accounts.containers.workspaces.tags.get"], {
			path: `${WORKSPACE}/tags/1?x=y#z`,
		});
		expect(calls[0]?.url.pathname).toBe(`/tagmanager/v2/${WORKSPACE}/tags/1%3Fx%3Dy%23z`);
		expect(calls[0]?.url.search).toBe("");
	});

	it("refuses absolute URLs, leading slashes and dot segments so the token stays on Google's API", () => {
		for (const bad of [
			"https://evil.example/x",
			"//evil.example/x",
			"/accounts",
			"accounts/../../oauth",
			"accounts/%2e%2e/x",
			"",
		]) {
			expect(() => resolveApiUrl(GTM_API_BASE_URL, bad), bad).toThrow(TypeError);
		}
		expect(resolveApiUrl(GTM_API_BASE_URL, "accounts/containers:lookup").href).toBe(
			`${GTM_API_BASE_URL}accounts/containers:lookup`,
		);
	});

	it("covers every Discovery method in the table", () => {
		expect(Object.keys(methods)).toHaveLength(106);
		expect(methods["accounts.containers.workspaces.tags.update"]).toMatchObject({
			httpMethod: "PUT",
			path: "{+path}",
			queryParams: ["fingerprint"],
			request: "Tag",
			response: "Tag",
		});
	});
});

describe("pagination", () => {
	const page = (n: number, next?: string) => json(200, { tag: [{ tagId: String(n) }], nextPageToken: next });

	it("follows nextPageToken until it runs out", async () => {
		const { client, calls } = testClient([page(1, "p2"), page(2, "p3"), page(3)]);
		const result = await client.listAll(
			(pageToken) => ws.tags.list(client, { parent: WORKSPACE, pageToken }),
			(p) => p.tag,
		);
		expect(result.items.map((t: Tag) => t.tagId)).toEqual(["1", "2", "3"]);
		expect(result).toMatchObject({ pages: 3, truncated: false });
		expect(calls.map((c) => c.url.searchParams.get("pageToken"))).toEqual([null, "p2", "p3"]);
	});

	it(`stops at ${DEFAULT_MAX_PAGES} pages and says it was truncated`, async () => {
		const { client, calls } = testClient((_call, n) => page(n + 1, `p${n + 2}`));
		const result = await listAll(
			(pageToken) => ws.tags.list(client, { parent: WORKSPACE, pageToken }),
			(p) => p.tag,
		);
		expect(calls).toHaveLength(DEFAULT_MAX_PAGES);
		expect(result.items).toHaveLength(DEFAULT_MAX_PAGES);
		expect(result.truncated).toBe(true);
		expect(result.nextPageToken).toBe(`p${DEFAULT_MAX_PAGES + 1}`);
	});

	it("honours a custom page cap", async () => {
		const { client, calls } = testClient((_call, n) => page(n + 1, "more"));
		const fetchPage = vi.fn((pageToken: string | undefined) => ws.tags.list(client, { parent: WORKSPACE, pageToken }));
		const result = await listAll(fetchPage, (p) => p.tag, { maxPages: 1 });
		expect(calls).toHaveLength(1);
		expect(result.truncated).toBe(true);
	});

	it("stops if Google repeats a page token", async () => {
		const { client, calls } = testClient([page(1, "same"), page(2, "same"), page(3)]);
		const result = await listAll(
			(pageToken) => ws.tags.list(client, { parent: WORKSPACE, pageToken }),
			(p) => p.tag,
		);
		expect(calls).toHaveLength(2);
		expect(result.truncated).toBe(false);
	});

	it("treats a page with no items as empty", async () => {
		const { client } = testClient([json(200, {})]);
		const result = await listAll(
			(pageToken) => ws.tags.list(client, { parent: WORKSPACE, pageToken }),
			(p) => p.tag,
		);
		expect(result.items).toEqual([]);
	});
});

describe("paths", () => {
	const ids = { accountId: "1", containerId: "2", workspaceId: "3" };

	it("builds every path", () => {
		expect(accountPath(ids)).toBe("accounts/1");
		expect(containerPath(ids)).toBe("accounts/1/containers/2");
		expect(workspacePath(ids)).toBe("accounts/1/containers/2/workspaces/3");
		expect(tagPath({ ...ids, tagId: "4" })).toBe("accounts/1/containers/2/workspaces/3/tags/4");
		expect(triggerPath({ ...ids, triggerId: "2147479553" })).toBe(
			"accounts/1/containers/2/workspaces/3/triggers/2147479553",
		);
		expect(variablePath({ ...ids, variableId: "5" })).toBe("accounts/1/containers/2/workspaces/3/variables/5");
		expect(folderPath({ ...ids, folderId: "0" })).toBe("accounts/1/containers/2/workspaces/3/folders/0");
		expect(builtInVariablesPath(ids)).toBe("accounts/1/containers/2/workspaces/3/built_in_variables");
		expect(versionPath({ ...ids, versionId: "12" })).toBe("accounts/1/containers/2/versions/12");
	});

	it("rejects IDs that are not numeric strings", () => {
		for (const bad of ["", "GTM-ABC123", "1/2", "../1", " 1", "1e3", "-1"]) {
			expect(() => assertGtmId("accountId", bad), bad).toThrow(InvalidGtmIdError);
		}
		expect(() => workspacePath({ ...ids, workspaceId: "default" })).toThrow(/workspaceId must be a numeric ID/);
	});

	it("recognises public container IDs", () => {
		expect(isPublicContainerId("GTM-ABC1234")).toBe(true);
		expect(isPublicContainerId("201")).toBe(false);
	});

	it("parses paths back into IDs", () => {
		expect(parseGtmPath("accounts/1")).toEqual({ accountId: "1" });
		expect(parseGtmPath("accounts/1/containers/2/versions/9")).toEqual({
			accountId: "1",
			containerId: "2",
			versionId: "9",
		});
		expect(parseGtmPath(TAG_PATH)).toEqual({
			accountId: "1234567890",
			containerId: "201",
			workspaceId: "7",
			entity: { kind: "tags", id: "12" },
		});
		for (const bad of [
			"accounts/x",
			"accounts/1/containers",
			"accounts/1/containers/2/workspaces/3/zones/4",
			"foo/1",
		]) {
			expect(() => parseGtmPath(bad), bad).toThrow(InvalidGtmIdError);
		}
	});
});

// Publishing and deleting containers and workspaces go through the generated wrappers like any
// other call. The tools gate them behind confirm: true (test/tools/*.test.ts).
describe("publish and delete requests", () => {
	const CONTAINER = "accounts/1234567890/containers/201";
	const VERSION = `${CONTAINER}/versions/43`;

	it("versions.publish POSTs {version}:publish", async () => {
		const { client, calls } = testClient([json(200, { containerVersion: { containerVersionId: "43" } })]);
		const response = await accounts.containers.versions.publish(client, { path: VERSION });
		expect(response.containerVersion?.containerVersionId).toBe("43");
		expect(calls.map((c) => `${c.method} ${c.url.pathname.replace("/tagmanager/v2/", "")}`)).toEqual([
			`POST ${VERSION}:publish`,
		]);
	});

	it("sends container, workspace, tag, trigger, variable, folder and version DELETEs", async () => {
		const { client, calls } = testClient([json(204)]);
		const ws = accounts.containers.workspaces;
		await ws.tags.delete(client, { path: TAG_PATH });
		await ws.triggers.delete(client, { path: TRIGGER_PATH });
		await ws.variables.delete(client, { path: VARIABLE_PATH });
		await ws.folders.delete(client, { path: FOLDER_PATH });
		await ws.delete(client, { path: WORKSPACE });
		await accounts.containers.versions.delete(client, { path: VERSION });
		await accounts.containers.delete(client, { path: CONTAINER });
		expect(calls.map((c) => `${c.method} ${c.url.pathname.replace("/tagmanager/v2/", "")}`)).toEqual([
			`DELETE ${TAG_PATH}`,
			`DELETE ${TRIGGER_PATH}`,
			`DELETE ${VARIABLE_PATH}`,
			`DELETE ${FOLDER_PATH}`,
			`DELETE ${WORKSPACE}`,
			`DELETE ${VERSION}`,
			`DELETE ${CONTAINER}`,
		]);
	});
});
