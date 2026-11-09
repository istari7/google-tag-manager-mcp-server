// A scripted fetch for GTM client tests: no network, no Workers bindings.

import { createGtmClient, type FetchLike, type GtmClient } from "../../src/gtm/client";

export interface RecordedCall {
	method: string;
	url: URL;
	headers: Record<string, string>;
	body: unknown;
}

export type Reply = { status: number; body?: unknown; text?: string } | Error;

export const TEST_TOKEN = "ya29.test-token-never-logged";

export function json(status: number, body?: unknown): Reply {
	return { status, body };
}

/**
 * Fake fetch that answers from `replies` in order (the last reply repeats once
 * the list runs out) and records every call.
 */
export function scriptedFetch(replies: Reply[] | ((call: RecordedCall, n: number) => Reply)) {
	const calls: RecordedCall[] = [];
	const fetch: FetchLike = async (input, init) => {
		const headers: Record<string, string> = {};
		new Headers(init.headers).forEach((v, k) => {
			headers[k] = v;
		});
		const raw = typeof init.body === "string" ? init.body : undefined;
		const call: RecordedCall = {
			method: init.method ?? "GET",
			url: new URL(input),
			headers,
			body: raw === undefined ? undefined : JSON.parse(raw),
		};
		calls.push(call);
		const n = calls.length - 1;
		const reply =
			typeof replies === "function" ? replies(call, n) : (replies[Math.min(n, replies.length - 1)] ?? json(200, {}));
		if (reply instanceof Error) throw reply;
		const text = reply.text ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
		return new Response(reply.status === 204 ? null : text, { status: reply.status });
	};
	return { fetch, calls };
}

export function testClient(replies: Reply[] | ((call: RecordedCall, n: number) => Reply)): {
	client: GtmClient;
	calls: RecordedCall[];
	sleeps: number[];
	tokenCalls: () => number;
} {
	const { fetch, calls } = scriptedFetch(replies);
	const sleeps: number[] = [];
	let tokens = 0;
	const client = createGtmClient({
		getToken: () => {
			tokens++;
			return TEST_TOKEN;
		},
		fetch,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	});
	return { client, calls, sleeps, tokenCalls: () => tokens };
}

/** The JSON body of recorded call `i`, typed. Fails the test if there was no such call or body. */
export function sentBody<T>(calls: readonly RecordedCall[], i: number): T {
	const call = calls[i];
	if (!call || call.body === undefined) throw new Error(`no request body at call ${i}`);
	return call.body as T;
}
