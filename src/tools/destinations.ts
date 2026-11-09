// Google tag destinations linked to a container (container-level, not versioned).
// Linking moves a destination away from the container it is linked to now, at once, so
// link_destination is confirm-gated. Like Paolo's server, we never send
// allowUserPermissionFeatureUpdate: a link that would turn on the container's user-permissions
// feature fails at Google instead of changing who can access what.

import { z } from "zod";
import type { GtmRequester } from "../gtm/client";
import { accounts, type Destination } from "../gtm/generated";
import { containerPath, destinationPath, isDestinationId } from "../gtm/paths";
import type { ToolGroup } from "../mcp/registry";
import { compact, ok, okEntity, okList } from "../mcp/result";
import { confirmGate, okPreview } from "./confirm";
import { confirmInput, containerInput } from "./inputs";

const destinations = accounts.containers.destinations;

export const DESTINATION_NOTE = "Destination links take effect immediately; they are not part of any version.";

export function destinationRow(d: Destination) {
	return { destinationLinkId: d.destinationLinkId, destinationId: d.destinationId, name: d.name };
}

const destinationIdInput = (what: string) =>
	z
		.string()
		.trim()
		.refine(isDestinationId, { message: `${what} must contain only letters, digits, "_" and "-"` })
		.describe(what);

/** destinations.list takes no pageToken, so it is one call. */
async function listDestinations(gtm: GtmRequester, parent: string) {
	const page = await destinations.list(gtm, { parent });
	return page.destination ?? [];
}

export const destinationTools: ToolGroup = (tools) => {
	tools.add(
		"list_destinations",
		{
			description: "List the Google tag destinations (e.g. G-…, AW-…) linked to a container.",
			input: containerInput,
			annotations: { readOnlyHint: true },
		},
		async (ids, { gtm }) => {
			const items = await listDestinations(gtm, containerPath(ids));
			return okList("destinations", { items, pages: 1, truncated: false }, destinationRow);
		},
	);

	tools.add(
		"get_destination",
		{
			description: "Get a linked destination by its destinationLinkId from list_destinations.",
			input: containerInput.extend({ destinationLinkId: destinationIdInput("Destination link ID") }),
			annotations: { readOnlyHint: true },
		},
		async (ids, { gtm }) => okEntity(await destinations.get(gtm, { path: destinationPath(ids) })),
	);

	tools.add(
		"link_destination",
		{
			description:
				"Link a destination (e.g. G-…) to this container, moving it from the container it is in now. Without confirm: true, only previews.",
			input: containerInput.extend({
				destinationId: destinationIdInput('Destination ID, e.g. "G-ABC123"'),
				confirm: confirmInput("link it"),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async ({ destinationId, confirm, ...ids }, { gtm }) => {
			const parent = containerPath(ids);
			return confirmGate({
				confirm,
				preview: async () => {
					const container = await accounts.containers.get(gtm, { path: parent });
					const linked = (await listDestinations(gtm, parent)).find((d) => d.destinationId === destinationId);
					if (linked) return ok({ alreadyLinked: compact(destinationRow(linked)) });
					return okPreview(
						{
							wouldLink: {
								destinationId,
								to: compact({ containerId: container.containerId, name: container.name, publicId: container.publicId }),
							},
						},
						"Nothing was changed. Linking removes the destination from the container it is linked to now, at once. Get the user's go-ahead, then call link_destination again with confirm: true.",
					);
				},
				apply: async () => {
					const linked = await destinations.link(gtm, { parent, destinationId });
					return ok({ linked: compact(destinationRow(linked)), note: DESTINATION_NOTE });
				},
			});
		},
	);
};
