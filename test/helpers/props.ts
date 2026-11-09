import type { Props } from "../../src/env";

/** Props as stored in a grant after a successful login. Tokens are obviously fake. */
export function fakeProps(overrides: Partial<Props> = {}): Props {
	return {
		email: "owner@example.com",
		name: "Owner",
		googleAccessToken: "ya29.fake-access-token",
		googleRefreshToken: "1//fake-refresh-token",
		googleExpiresAt: Date.now() + 3600_000,
		googleScopes: ["openid", "email", "https://www.googleapis.com/auth/tagmanager.readonly"],
		...overrides,
	};
}
