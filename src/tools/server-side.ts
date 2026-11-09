// Server-side GTM: clients (which claim incoming requests) and transformations (which edit
// event data before tags see it). Both exist only in server containers (usageContext
// "server"). On any other container GTM fails with an error that doesn't say why, so on
// failure we read the container and, if it isn't a server container, say that instead.
// Both use the same Parameter shape as tags, and the same get-merge-put update (Q1, Q2, Q7).

import { z } from "zod";
import type { GtmClient } from "../gtm/client";
import { GtmApiError, GtmInputError } from "../gtm/errors";
import { accounts, type Client, type Transformation } from "../gtm/generated";
import { getMergePut } from "../gtm/merge";
import { clientPath, transformationPath, workspacePath } from "../gtm/paths";
import type { ToolGroup } from "../mcp/registry";
import { fail } from "../mcp/result";
import { addDeleteTool, addGetTool, addListTool, type WorkspaceEntityApi, workspaceEntity } from "./entity";
import { fingerprintInput, gtmId, nameInput, notesInput, parametersInput, workspaceInput } from "./inputs";
import { isEmptyPatch, okWrite } from "./write";

const ws = accounts.containers.workspaces;

/** Errors a server-only call on another kind of container could plausibly come back with. */
const MAYBE_WRONG_CONTAINER = new Set(["invalid", "notFound", "permission"]);

/**
 * Throws a clear GtmInputError when the container holding `path` is not a server container.
 * Returns quietly when it is, or when the container can't be read (the caller then keeps
 * its own result or error).
 */
async function assertServerContainer(gtm: GtmClient, path: string, what: string): Promise<void> {
	const containerPath = path.split("/").slice(0, 4).join("/");
	const container = await accounts.containers.get(gtm, { path: containerPath }).catch(() => undefined);
	const usage = container?.usageContext;
	if (!usage?.length || usage.includes("server")) return;
	throw new GtmInputError(
		`${what} exist only in server-side containers; ${container?.publicId ?? containerPath} is a ${usage.join("/")} container.`,
	);
}

/** Runs a client/transformation call; a failure on a non-server container is explained. */
async function serverOnly<R>(gtm: GtmClient, path: string, what: string, call: () => Promise<R>): Promise<R> {
	try {
		return await call();
	} catch (error) {
		if (error instanceof GtmApiError && MAYBE_WRONG_CONTAINER.has(error.kind)) {
			await assertServerContainer(gtm, path, what);
		}
		throw error;
	}
}

/**
 * The generated list/get/delete calls, guarded by serverOnly. An empty first-and-only list
 * page is also checked, in case GTM answers a web container with an empty list.
 */
function serverOnlyApi<T, P extends { nextPageToken?: string }>(
	api: WorkspaceEntityApi<T, P>,
	what: string,
	items: (page: P) => T[] | undefined,
): WorkspaceEntityApi<T, P> {
	return {
		list: async (gtm, params) => {
			const page = await serverOnly(gtm, params.parent, what, () => api.list(gtm, params));
			if (params.pageToken === undefined && !page.nextPageToken && !items(page)?.length) {
				await assertServerContainer(gtm, params.parent, what);
			}
			return page;
		},
		get: (gtm, params) => serverOnly(gtm, params.path, what, () => api.get(gtm, params)),
		delete: (gtm, params) => serverOnly(gtm, params.path, what, () => api.delete(gtm, params)),
	};
}

const plain = <T>(patch: Partial<T>) => ({ value: patch, warnings: [] });

/** Fields clients and transformations share. Google's names, so get_* output can be sent back. */
const commonFields = (what: string, type: string) =>
	z.object({
		name: nameInput(what),
		type: z.string().trim().min(1).describe(type),
		parameter: parametersInput.describe("GTM parameters, as on tags; [] clears on update").optional(),
		notes: notesInput,
	});

const WRITE = { readOnlyHint: false, destructiveHint: false } as const;

// ---- Clients ------------------------------------------------------------------------

export function clientRow(c: Client) {
	return { clientId: c.clientId, name: c.name, type: c.type, priority: c.priority, parentFolderId: c.parentFolderId };
}

const clientFields = commonFields("Client", 'Client type, e.g. "gaaw_client" (GA4)').extend({
	// A refine, not .int(): .int() adds ±2^53 bounds to the tools/list schema.
	priority: z
		.number()
		.refine(Number.isInteger, { message: "priority must be a whole number" })
		.optional()
		.describe("Higher claims requests first"),
});
const clientIdInput = { clientId: gtmId("Client ID") };
const clients = serverOnlyApi(ws.clients, "Clients", (page) => page.client);

const client = workspaceEntity({
	kind: "client",
	ids: workspaceInput.extend(clientIdInput),
	id: (ids) => ids.clientId,
	path: clientPath,
	api: clients,
	items: (page) => page.client,
	row: clientRow,
});

// ---- Transformations ----------------------------------------------------------------

export function transformationRow(t: Transformation) {
	return { transformationId: t.transformationId, name: t.name, type: t.type, parentFolderId: t.parentFolderId };
}

const transformationFields = commonFields("Transformation", "tf_exclude_params, tf_allow_params or tf_augment_event");
const transformationIdInput = { transformationId: gtmId("Transformation ID") };
const transformations = serverOnlyApi(ws.transformations, "Transformations", (page) => page.transformation);

const transformation = workspaceEntity({
	kind: "transformation",
	ids: workspaceInput.extend(transformationIdInput),
	id: (ids) => ids.transformationId,
	path: transformationPath,
	api: transformations,
	items: (page) => page.transformation,
	row: transformationRow,
});

// ---- Tools --------------------------------------------------------------------------

const SERVER = "Server containers only.";
const PREVIEW = "Without confirm: true, only previews.";
const UPDATE = "omitted fields are kept, [] clears parameters. Pass the fingerprint from";

export const serverTools: ToolGroup = (tools) => {
	addListTool(tools, client, {
		name: "list_clients",
		key: "clients",
		description: `List a workspace's clients (ID, name, type, priority). ${SERVER}`,
	});

	addGetTool(tools, client, {
		name: "get_client",
		description: `Get one client with its parameters and fingerprint. ${SERVER}`,
	});

	tools.add(
		"create_client",
		{
			description: `Create a client, which claims incoming requests (e.g. GA4 hits). ${SERVER}`,
			input: workspaceInput.extend(clientFields.shape),
			annotations: { ...WRITE, idempotentHint: false },
		},
		async ({ accountId, containerId, workspaceId, ...fields }, { gtm }) => {
			const parent = workspacePath({ accountId, containerId, workspaceId });
			const result = await serverOnly(gtm, parent, "Clients", () => ws.clients.create(gtm, { parent }, fields));
			return okWrite({ client: result });
		},
	);

	tools.add(
		"update_client",
		{
			description: `Change some fields of a client; ${UPDATE} get_client. ${SERVER}`,
			input: workspaceInput
				.extend(clientIdInput)
				.extend(clientFields.partial().shape)
				.extend({ fingerprint: fingerprintInput }),
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ accountId, containerId, workspaceId, clientId, fingerprint, ...fields }, { gtm }) => {
			if (isEmptyPatch(fields)) return fail("Nothing to update: pass at least one client field.");
			const path = clientPath({ accountId, containerId, workspaceId, clientId });
			const { result } = await serverOnly(gtm, path, "Clients", () =>
				getMergePut<Client, Partial<Client>>({
					path,
					patch: fields,
					expectedFingerprint: fingerprint,
					get: () => ws.clients.get(gtm, { path }),
					put: (body, fp) => ws.clients.update(gtm, { path, fingerprint: fp }, body),
					normalize: plain,
				}),
			);
			return okWrite({ client: result });
		},
	);

	addDeleteTool(tools, client, { name: "delete_client", description: `Delete a client. ${PREVIEW} ${SERVER}` });

	addListTool(tools, transformation, {
		name: "list_transformations",
		key: "transformations",
		description: `List a workspace's transformations (ID, name, type). ${SERVER}`,
	});

	addGetTool(tools, transformation, {
		name: "get_transformation",
		description: `Get one transformation with its parameters and fingerprint. ${SERVER}`,
	});

	tools.add(
		"create_transformation",
		{
			description: `Create a transformation, which edits event data before tags read it. Its table parameter is excludedParamsTable, allowedParamsTable or augmentEventTable. ${SERVER}`,
			input: workspaceInput.extend(transformationFields.shape),
			annotations: { ...WRITE, idempotentHint: false },
		},
		async ({ accountId, containerId, workspaceId, ...fields }, { gtm }) => {
			const parent = workspacePath({ accountId, containerId, workspaceId });
			const result = await serverOnly(gtm, parent, "Transformations", () =>
				ws.transformations.create(gtm, { parent }, fields),
			);
			return okWrite({ transformation: result });
		},
	);

	tools.add(
		"update_transformation",
		{
			description: `Change some fields of a transformation; ${UPDATE} get_transformation. ${SERVER}`,
			input: workspaceInput
				.extend(transformationIdInput)
				.extend(transformationFields.partial().shape)
				.extend({ fingerprint: fingerprintInput }),
			annotations: { ...WRITE, idempotentHint: true },
		},
		async ({ accountId, containerId, workspaceId, transformationId, fingerprint, ...fields }, { gtm }) => {
			if (isEmptyPatch(fields)) return fail("Nothing to update: pass at least one transformation field.");
			const path = transformationPath({ accountId, containerId, workspaceId, transformationId });
			const { result } = await serverOnly(gtm, path, "Transformations", () =>
				getMergePut<Transformation, Partial<Transformation>>({
					path,
					patch: fields,
					expectedFingerprint: fingerprint,
					get: () => ws.transformations.get(gtm, { path }),
					put: (body, fp) => ws.transformations.update(gtm, { path, fingerprint: fp }, body),
					normalize: plain,
				}),
			);
			return okWrite({ transformation: result });
		},
	);

	addDeleteTool(tools, transformation, {
		name: "delete_transformation",
		description: `Delete a transformation. ${PREVIEW} ${SERVER}`,
	});
};
