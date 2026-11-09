import type { ToolGroup } from "../mcp/registry";
import { ok } from "../mcp/result";
import { NO_INPUT } from "./inputs";

export const utilityTools: ToolGroup = (tools) => {
	tools.add(
		"ping",
		{ description: "Check the server is reachable.", input: NO_INPUT, annotations: { readOnlyHint: true } },
		() => ok("pong"),
	);

	tools.add(
		"auth_status",
		{
			description: "Show which Google account is connected, the granted scopes, and when the Google token expires.",
			input: NO_INPUT,
			annotations: { readOnlyHint: true },
		},
		// Email, name, scopes and expiry only. Never the tokens.
		(_args, { props }) =>
			ok({
				email: props.email,
				name: props.name,
				googleScopes: props.googleScopes,
				googleTokenExpiresAt: new Date(props.googleExpiresAt).toISOString(),
				googleTokenExpiresInSeconds: Math.round((props.googleExpiresAt - Date.now()) / 1000),
			}),
	);
};
