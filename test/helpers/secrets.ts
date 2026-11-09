/**
 * Test-only secrets, bound by vitest.config.ts. They override anything in a local .dev.vars,
 * so tests never depend on it and never see real credentials. Plain constants: this file is
 * imported both by the Node-side config and by tests running in workerd.
 */
export const TEST_SECRETS = {
	GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
	GOOGLE_CLIENT_SECRET: "test-client-secret",
	COOKIE_SECRET: "test-cookie-secret-0123456789abcdef0123456789",
	ALLOWED_EMAILS: "owner@example.com",
	ALLOWED_DOMAINS: "allowed.example",
} as const;
