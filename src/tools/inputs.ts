// Shared zod input schemas. IDs are strings checked to be numeric (gtm/paths.ts), so a tool
// argument can never reshape a GTM API path. The path builders check again.
//
// Write tools take GTM's own field names (`parameter`, `firingTriggerId`, `filter`, …), so
// the model can send back what get_* returned. The Parameter and Condition schemas below
// mirror the generated types (`satisfies` keeps the enums in step with generated.ts).

import { z } from "zod";
import type { Condition, Parameter } from "../gtm/generated";
import { isGtmId } from "../gtm/paths";
import type { ConditionInput } from "../gtm/quirks";

export const NO_INPUT = z.object({});

/** A numeric GTM ID passed as a string, e.g. "1234567890". */
export function gtmId(what: string) {
	return z
		.string()
		.refine(isGtmId, { message: `${what} must be a numeric ID such as "123"` })
		.describe(what);
}

export const accountInput = z.object({ accountId: gtmId("Account ID") });
export const containerInput = accountInput.extend({ containerId: gtmId("Container ID (numeric, not GTM-XXXX)") });
export const workspaceInput = containerInput.extend({ workspaceId: gtmId("Workspace ID") });

export type AccountInput = z.output<typeof accountInput>;
export type ContainerInput = z.output<typeof containerInput>;
export type WorkspaceInput = z.output<typeof workspaceInput>;

// ---- Common write fields ------------------------------------------------------------

/** A list of numeric IDs, e.g. firing trigger IDs. The items carry no description, to save bytes. */
export const idList = (what: string) =>
	z
		.array(z.string().refine(isGtmId, { message: `${what} IDs must be numeric, such as "123"` }))
		.describe(`${what} IDs`);

export const nameInput = (what: string) => z.string().trim().min(1).max(256).describe(`${what} name`);

export const notesInput = z.string().optional().describe('Notes; "" clears them on update');

/** Q2: the fingerprint from the model's earlier get_*; a mismatch fails instead of overwriting. */
export const fingerprintInput = z
	.string()
	.optional()
	.describe("From get_*: the update fails if the entity changed since");

/** Deletes: without `confirm: true` they only return a preview. */
export const confirmInput = (action: string) =>
	z.boolean().optional().describe(`true to ${action}; omit to only preview`);

// ---- Parameter / Condition (generated.ts shapes) ------------------------------------

const PARAMETER_TYPES = [
	"template",
	"integer",
	"boolean",
	"list",
	"map",
	"triggerReference",
	"tagReference",
] as const satisfies readonly NonNullable<Parameter["type"]>[];

/** Recursive like Google's Parameter: `list` items and `map` entries are Parameters too. */
export const parameterInput = z
	.object({
		type: z.enum(PARAMETER_TYPES),
		key: z.string().optional(),
		value: z.string().optional(),
		get list() {
			return z.array(parameterInput).optional();
		},
		get map() {
			return z.array(parameterInput).optional();
		},
	})
	.meta({ id: "Parameter" });

export const parametersInput = z
	.array(parameterInput)
	.describe('GTM parameters, e.g. {"type":"template","key":"eventName","value":"sign_up"}; [] clears on update');

// Compile-time check: what the schema produces is a valid generated Parameter.
const _parameterFits: (p: z.output<typeof parameterInput>) => Parameter = (p) => p;

const CONDITION_TYPES = [
	"equals",
	"contains",
	"startsWith",
	"endsWith",
	"matchRegex",
	"greater",
	"greaterOrEquals",
	"less",
	"lessOrEquals",
	"cssSelector",
	"urlMatches",
] as const satisfies readonly NonNullable<Condition["type"]>[];

/** Google's Condition plus the Q5 conveniences (`doesNotContain`, `negate`) from quirks.ts. */
export const conditionInput = z
	.object({
		type: z.enum([...CONDITION_TYPES, "doesNotContain"]),
		parameter: z.array(parameterInput).describe("arg0: the variable, e.g. {{Click URL}}; arg1: the value"),
		negate: z.boolean().optional(),
	})
	.meta({ id: "Condition" });

const _conditionFits: (c: z.output<typeof conditionInput>) => ConditionInput = (c) => c;

export const conditionsInput = (where: string) => z.array(conditionInput).optional().describe(where);
