// Zones (GTM 360): where in a page child containers may load and which tag types they may use.
// Workspace entities like tags, so changes are not live until a version is published (Q9).

import { z } from "zod";
import { accounts, type Zone } from "../gtm/generated";
import { getMergePut, mergeForUpdate, stripServerFields } from "../gtm/merge";
import { isPublicContainerId, workspacePath, zonePath } from "../gtm/paths";
import { normalizeConditions } from "../gtm/quirks";
import type { ToolGroup } from "../mcp/registry";
import { fail } from "../mcp/result";
import { addDeleteTool, addGetTool, addListTool, workspaceEntity } from "./entity";
import { conditionInput, fingerprintInput, gtmId, idList, nameInput, notesInput, workspaceInput } from "./inputs";
import { isEmptyPatch, okWrite } from "./write";

const zones = accounts.containers.workspaces.zones;

export function zoneRow(z: Zone) {
	return {
		zoneId: z.zoneId,
		name: z.name,
		childContainers: z.childContainer?.map((c) => c.publicId),
		typeRestriction: z.typeRestriction?.enable,
	};
}

const zone = workspaceEntity({
	kind: "zone",
	ids: workspaceInput.extend({ zoneId: gtmId("Zone ID") }),
	id: (ids) => ids.zoneId,
	path: zonePath,
	api: zones,
	items: (page) => page.zone,
	row: zoneRow,
});

/**
 * Boundary conditions arrive as a JSON string, parsed and validated here with the trigger
 * Condition schema. Taking them as a typed array would repeat the Condition and Parameter
 * JSON Schemas in both zone tools (~1.5 KB of the tools/list budget) for a GTM 360-only feature.
 */
const conditionsJson = z
	.string()
	.transform((text, ctx): unknown => {
		try {
			return JSON.parse(text);
		} catch {
			ctx.addIssue({ code: "custom", message: "must be a JSON array of conditions" });
			return z.NEVER;
		}
	})
	.pipe(z.array(conditionInput))
	.describe('Boundary: JSON array of trigger-style conditions ({type, parameter: [arg0, arg1]}), ANDed; "[]" clears');

/** Zone fields a caller may set (Google's names). `condition` and `customEvaluationTriggerId` form `boundary`. */
const zoneFields = z.object({
	name: nameInput("Zone"),
	notes: notesInput,
	condition: conditionsJson.optional(),
	customEvaluationTriggerId: idList("Boundary evaluation trigger").optional(),
	childContainer: z
		.array(
			z.object({
				publicId: z
					.string()
					.transform((s) => s.trim().toUpperCase())
					.refine(isPublicContainerId, { message: 'publicId must look like "GTM-ABC1234"' }),
				nickname: z.string().optional(),
			}),
		)
		.optional()
		.describe("Child containers (GTM-XXXX); [] clears"),
	typeRestriction: z
		.object({
			enable: z.boolean().optional(),
			whitelistedTypeId: z.array(z.string()).optional().describe("Allowed tag type IDs"),
		})
		.optional(),
});

type ZoneFields = Partial<z.output<typeof zoneFields>>;

/**
 * Turn the caller's fields into a Zone patch. Q5: boundary conditions get the same
 * `doesNotContain` / `negate` handling as trigger filters. Q1/Q7 one level down: the boundary
 * and `typeRestriction` are overlaid on the stored ones, so changing one sub-field keeps the other.
 */
function zonePatch(
	{ condition, customEvaluationTriggerId, typeRestriction, ...rest }: ZoneFields,
	current?: Zone,
): Partial<Zone> {
	const patch: Partial<Zone> = { ...rest };
	if (condition !== undefined || customEvaluationTriggerId !== undefined) {
		patch.boundary = mergeForUpdate(current?.boundary ?? {}, {
			condition: normalizeConditions(condition),
			customEvaluationTriggerId,
		});
	}
	if (typeRestriction) patch.typeRestriction = mergeForUpdate(current?.typeRestriction ?? {}, typeRestriction);
	return patch;
}

export const zoneTools: ToolGroup = (tools) => {
	addListTool(tools, zone, {
		name: "list_zones",
		key: "zones",
		description: "List the zones in a GTM workspace (GTM 360): child containers and type restrictions.",
	});

	addGetTool(tools, zone, {
		name: "get_zone",
		description: "Get one zone with its boundary, child containers, type restrictions and fingerprint.",
	});

	tools.add(
		"create_zone",
		{
			description: "Create a zone in a workspace (GTM 360). Not live until a version is published.",
			input: workspaceInput.extend(zoneFields.shape),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async ({ accountId, containerId, workspaceId, ...fields }, { gtm }) => {
			const parent = workspacePath({ accountId, containerId, workspaceId });
			const result = await zones.create(gtm, { parent }, stripServerFields(zonePatch(fields)));
			return okWrite({ zone: result });
		},
	);

	tools.add(
		"update_zone",
		{
			description:
				"Change some fields of a zone; omitted fields are kept. Pass the fingerprint from get_zone to avoid overwriting newer edits.",
			input: zone.ids.extend(zoneFields.partial().shape).extend({ fingerprint: fingerprintInput }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async ({ accountId, containerId, workspaceId, zoneId, fingerprint, ...fields }, { gtm }) => {
			if (isEmptyPatch(fields)) return fail("Nothing to update: pass at least one zone field.");
			const path = zonePath({ accountId, containerId, workspaceId, zoneId });
			const { result } = await getMergePut<Zone, ZoneFields>({
				path,
				patch: fields,
				expectedFingerprint: fingerprint,
				get: () => zones.get(gtm, { path }),
				put: (body, stored) => zones.update(gtm, { path, fingerprint: stored }, body),
				normalize: (patch, current) => ({ value: zonePatch(patch, current), warnings: [] }),
			});
			return okWrite({ zone: result });
		},
	);

	addDeleteTool(tools, zone, {
		name: "delete_zone",
		description: "Delete a zone from a workspace. Without confirm: true, only shows what would be deleted.",
	});
};
