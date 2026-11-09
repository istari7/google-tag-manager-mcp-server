// ping, auth_status, and the per-request Google token handling in src/mcp/context.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import { errors } from "../fixtures/gtm";
import { GOOGLE_TOKEN_URL, json } from "../helpers/google";
import { fakeProps } from "../helpers/props";
import { callTool, describeCall, FAKE_GOOGLE_TOKEN, mockGtm, reply } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ping", () => {
	it("answers pong without calling Google", async () => {
		const mock = mockGtm();
		const result = await callTool("ping");
		expect(result).toMatchObject({ text: "pong", isError: false });
		expect(mock.calls).toHaveLength(0);
	});
});

describe("auth_status", () => {
	it("shows email, name, scopes and expiry, never tokens", async () => {
		const mock = mockGtm();
		const props = fakeProps({ googleExpiresAt: Date.UTC(2030, 0, 1) });
		const result = await callTool("auth_status", {}, props);
		const status = result.json();
		expect(Object.keys(status).sort()).toEqual(
			["email", "googleScopes", "googleTokenExpiresAt", "googleTokenExpiresInSeconds", "name"].sort(),
		);
		expect(status).toMatchObject({
			email: "owner@example.com",
			name: "Owner",
			googleScopes: props.googleScopes,
			googleTokenExpiresAt: "2030-01-01T00:00:00.000Z",
		});
		expect(result.text).not.toContain(props.googleAccessToken);
		expect(result.text).not.toContain(props.googleRefreshToken);
		expect(mock.calls).toHaveLength(0);
	});
});

describe("Google token per request", () => {
	const accounts = { accounts: reply({ account: [{ accountId: "1", name: "Sandbox" }] }) };

	it("sends the grant's Google token while it is fresh", async () => {
		const mock = mockGtm(accounts);
		await callTool("list_accounts");
		expect(describeCall(mock.gtm()[0]).auth).toBe(`Bearer ${FAKE_GOOGLE_TOKEN}`);
		expect(mock.to(GOOGLE_TOKEN_URL)).toHaveLength(0);
	});

	it("refreshes in memory when the Google token is about to expire", async () => {
		const mock = mockGtm(accounts, {
			[GOOGLE_TOKEN_URL]: () => json({ access_token: "ya29.refreshed-in-memory", expires_in: 3599 }),
		});
		const props = fakeProps({ googleExpiresAt: Date.now() + 30_000 });
		const result = await callTool("list_accounts", {}, props);
		expect(result.isError).toBe(false);
		const [refresh] = mock.to(GOOGLE_TOKEN_URL);
		expect(refresh?.form).toMatchObject({ grant_type: "refresh_token", refresh_token: props.googleRefreshToken });
		expect(describeCall(mock.gtm()[0]).auth).toBe("Bearer ya29.refreshed-in-memory");
		expect(result.text).not.toContain("ya29.");
	});

	it("maps Google invalid_grant to the reconnect message without calling GTM", async () => {
		const mock = mockGtm(accounts, {
			[GOOGLE_TOKEN_URL]: () => json({ error: "invalid_grant", error_description: "Token has been expired" }, 400),
		});
		const result = await callTool("list_accounts", {}, fakeProps({ googleExpiresAt: Date.now() - 1000 }));
		expect(result).toEqual(
			expect.objectContaining({ isError: true, text: "Google session expired. Reconnect the GTM connector." }),
		);
		expect(mock.gtm()).toHaveLength(0);
	});

	it("maps a GTM 401 to the reconnect message", async () => {
		mockGtm({ accounts: reply(errors.unauthenticated401, 401) });
		const result = await callTool("list_accounts");
		expect(result).toMatchObject({ isError: true, text: "Google session expired. Reconnect the GTM connector." });
	});
});
