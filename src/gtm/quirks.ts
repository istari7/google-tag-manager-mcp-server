// Pure normalisation for things the GTM API gets wrong or silently ignores.
// Every function here is covered by test/quirks.test.ts; see GTM_API_QUIRKS.md
// for the quirk numbers (Qn) and where each one came from.

import { GtmInputError } from "./errors";
import type {
	Condition,
	CreateContainerVersionResponse,
	Parameter,
	Tag,
	TagConsentSetting,
	Trigger,
	Variable,
} from "./generated";

/** Condition types Google accepts. */
export type ConditionType = NonNullable<Condition["type"]>;

/**
 * A condition as a caller may write it. Accepts the Google shape plus two
 * conveniences: `type: "doesNotContain"` and `negate: true` (Q5).
 */
export interface ConditionInput {
	type?: ConditionType | "doesNotContain";
	parameter?: Parameter[];
	/** Shorthand for a `{ type: "boolean", key: "negate", value: "true" }` parameter. */
	negate?: boolean;
}

/** A trigger as a caller may write it: Google's Trigger with relaxed conditions. */
export type TriggerInput = Omit<Trigger, "filter" | "autoEventFilter" | "customEventFilter"> & {
	filter?: ConditionInput[];
	autoEventFilter?: ConditionInput[];
	customEventFilter?: ConditionInput[];
};

export interface Normalized<T> {
	value: T;
	/** Things we changed that the caller (and the model) should be told about. */
	warnings: string[];
}

// ---- Q5: doesNotContain ------------------------------------------------------

const NEGATE_TRUE: Parameter = { type: "boolean", key: "negate", value: "true" };

/**
 * Q5: Google has no `doesNotContain`; the UI stores it as `contains` plus a
 * boolean `negate` parameter. Also turns `negate: true` into that parameter,
 * without duplicating one that is already there.
 */
export function normalizeCondition(input: ConditionInput): Condition {
	let type = input.type;
	let negate = input.negate === true;
	if (type === "doesNotContain") {
		type = "contains";
		negate = true;
	}
	const parameter = input.parameter ? input.parameter.map((p) => ({ ...p })) : undefined;
	const out: Condition = {};
	if (type !== undefined) out.type = type;
	if (!negate) {
		if (parameter) out.parameter = parameter;
		return out;
	}
	const rest = (parameter ?? []).filter((p) => p.key !== "negate");
	out.parameter = [...rest, { ...NEGATE_TRUE }];
	return out;
}

/** Normalises a condition list, keeping `undefined` (= keep current) apart from `[]` (= clear) (Q7). */
export function normalizeConditions(list: readonly ConditionInput[] | undefined): Condition[] | undefined {
	return list === undefined ? undefined : list.map(normalizeCondition);
}

// ---- Q3 / Q4: click, linkClick, formSubmission --------------------------------

export const CLICK_LINK_FORM_TRIGGER_TYPES = ["click", "linkClick", "formSubmission"] as const;

/** Q3: trigger types for which Google silently drops `autoEventFilter`. */
export function isClickLinkFormTrigger(type: string | undefined): boolean {
	return type !== undefined && (CLICK_LINK_FORM_TRIGGER_TYPES as readonly string[]).includes(type);
}

/**
 * Q4: trigger types that take the companion fields. Not `click`: Google
 * silently drops waitForTags / checkValidation / waitForTagsTimeout there.
 */
export const COMPANION_TRIGGER_TYPES = ["linkClick", "formSubmission"] as const;

/** Q4: true for linkClick and formSubmission, the only types that keep the companion fields. */
export function takesClickCompanions(type: string | undefined): boolean {
	return type !== undefined && (COMPANION_TRIGGER_TYPES as readonly string[]).includes(type);
}

/** Q4: companion fields for linkClick and formSubmission triggers, with exact parameter types. */
export const CLICK_TRIGGER_COMPANIONS = {
	waitForTags: { type: "boolean", value: "false" },
	checkValidation: { type: "boolean", value: "false" },
	waitForTagsTimeout: { type: "integer", value: "2000" },
} as const satisfies Record<"waitForTags" | "checkValidation" | "waitForTagsTimeout", Parameter>;

type CompanionKey = keyof typeof CLICK_TRIGGER_COMPANIONS;

/**
 * Keep an existing companion value when it already has the right parameter
 * type; coerce its type when the value fits; otherwise use the default.
 */
function fixCompanion(existing: Parameter | undefined, key: CompanionKey): Parameter {
	const def = CLICK_TRIGGER_COMPANIONS[key];
	if (!existing) return { ...def };
	if (existing.type === def.type) return existing;
	const value = existing.value ?? "";
	const fits = def.type === "boolean" ? value === "true" || value === "false" : /^\d+$/.test(value);
	return fits ? { ...existing, type: def.type } : { ...def };
}

export const AUTO_EVENT_FILTER_WARNING =
	"The autoEventFilter conditions were appended to the existing filter (Google silently ignores autoEventFilter on click, linkClick and formSubmission triggers). To replace the filter instead, send filter.";

/**
 * Normalise a trigger body (create) or a trigger patch (update).
 *
 * - Q5: conditions in all three filter lists are normalised.
 * - Q3/Q10: for click/linkClick/formSubmission, a non-empty `autoEventFilter`
 *   is appended to `filter` and removed from the body, so Google keeps the
 *   current value. The base is the patch's `filter` when given (so `[]` plus
 *   `autoEventFilter` replaces it), else the stored filter on update.
 * - Q4/Q11: when that remap happens on linkClick or formSubmission,
 *   waitForTags / checkValidation / waitForTagsTimeout are filled in if
 *   missing or wrongly typed. Values the patch or the current trigger already
 *   have are kept. Not on click: Google drops those fields there, so any the
 *   caller sends are passed through untouched.
 * - Q6: `uniqueTriggerId` is removed.
 *
 * `current` is the stored trigger on update (used for the effective type and
 * existing companion values); omit it on create.
 */
export function normalizeTrigger(input: TriggerInput, current?: Trigger): Normalized<Partial<Trigger>> {
	const { filter: rawFilter, autoEventFilter: rawAuto, customEventFilter: rawCustom, ...rest } = input;
	const out: Partial<Trigger> = { ...rest };
	delete out.uniqueTriggerId;
	const warnings: string[] = [];

	let filter = normalizeConditions(rawFilter);
	let autoEventFilter = normalizeConditions(rawAuto);
	const customEventFilter = normalizeConditions(rawCustom);

	const type = input.type ?? current?.type;
	if (isClickLinkFormTrigger(type) && autoEventFilter !== undefined && autoEventFilter.length > 0) {
		filter = [...(filter ?? current?.filter ?? []), ...autoEventFilter];
		autoEventFilter = undefined;
		warnings.push(AUTO_EVENT_FILTER_WARNING);
		if (takesClickCompanions(type)) {
			for (const key of Object.keys(CLICK_TRIGGER_COMPANIONS) as CompanionKey[]) {
				out[key] = fixCompanion(input[key] ?? current?.[key], key);
			}
		}
	}

	if (filter !== undefined) out.filter = filter;
	if (autoEventFilter !== undefined) out.autoEventFilter = autoEventFilter;
	if (customEventFilter !== undefined) out.customEventFilter = customEventFilter;
	return { value: out, warnings };
}

// ---- Q15: Data Layer Variable defaultValue -----------------------------------

export const DLV_DEFAULT_VALUE_WARNING =
	'The Data Layer Variable defaultValue was empty with type "integer"; it was sent as an empty "template" instead.';

/**
 * Q15: a Data Layer Variable (`type: "v"`) with an empty `integer`
 * `defaultValue` is rejected; send it as an empty `template` instead.
 */
export function normalizeVariable<T extends Partial<Variable>>(input: T, current?: Variable): Normalized<T> {
	const type = input.type ?? current?.type;
	if (type !== "v" || !input.parameter) return { value: input, warnings: [] };
	let changed = false;
	const parameter = input.parameter.map((p) => {
		if (p.key === "defaultValue" && p.type === "integer" && (p.value ?? "") === "") {
			changed = true;
			return { ...p, type: "template" as const, value: "" };
		}
		return p;
	});
	return changed
		? { value: { ...input, parameter }, warnings: [DLV_DEFAULT_VALUE_WARNING] }
		: { value: input, warnings: [] };
}

// ---- Q14: consent settings -----------------------------------------------------

export type ConsentStatus = NonNullable<TagConsentSetting["consentStatus"]>;

/**
 * Q14: build `Tag.consentSettings`. For `needed`, the consent types go in a
 * `list` parameter of `template` items, e.g. ad_storage, analytics_storage.
 */
export function buildConsentSettings(status: ConsentStatus, consentTypes: readonly string[] = []): TagConsentSetting {
	const types = consentTypes.map((t) => t.trim()).filter((t) => t !== "");
	if (status !== "needed" || types.length === 0) return { consentStatus: status };
	return {
		consentStatus: status,
		consentType: { type: "list", list: types.map((value) => ({ type: "template", value })) },
	};
}

/** A tag as a caller may write it: Google's Tag plus the Q14 consent shorthand. */
export type TagInput = Partial<Tag> & { consentStatus?: ConsentStatus; consentTypes?: readonly string[] };

/**
 * Q14 on create and update: turn `consentStatus` / `consentTypes` into `consentSettings`.
 *
 * - `consentTypes` apply only when the status is `needed`: the patch's status,
 *   or on update the stored one, so `consentTypes` alone change the types of a
 *   tag already stored as `needed`. Without either, they are refused.
 * - On update, `consentStatus: "needed"` without `consentTypes` keeps the stored
 *   types (the merge is shallow, so a fresh object would erase them).
 * - Any other status drops the types; Google ignores them.
 *
 * `current` is the stored tag on update; omit it on create. Throws GtmInputError
 * for a combination we refuse, before anything is written.
 */
export function normalizeTag(input: TagInput, current?: Tag): Normalized<Partial<Tag>> {
	const { consentStatus, consentTypes, ...rest } = input;
	if (consentStatus === undefined && consentTypes === undefined) return { value: rest, warnings: [] };
	const storedStatus = current?.consentSettings?.consentStatus;
	const status = consentStatus ?? storedStatus;
	if (consentStatus === undefined && status !== "needed") {
		throw new GtmInputError(
			current
				? `consentTypes needs consentStatus: "needed" (the stored consent status is "${storedStatus ?? "notSet"}").`
				: 'consentTypes needs consentStatus: "needed".',
		);
	}
	let consentSettings: TagConsentSetting;
	if (status === "needed" && consentTypes === undefined) {
		const kept = storedStatus === "needed" ? current?.consentSettings?.consentType : undefined;
		consentSettings = kept ? { consentStatus: "needed", consentType: kept } : { consentStatus: "needed" };
	} else {
		consentSettings = buildConsentSettings(status ?? "notSet", consentTypes);
	}
	return { value: { ...rest, consentSettings }, warnings: [] };
}

// ---- Q20: create_version outcome ----------------------------------------

/**
 * Q20: create_version can "succeed" without making a version: no
 * containerVersion (nothing to version), a compiler error, or a merge
 * conflict. Returns a model-friendly reason, or undefined when a version was made.
 */
export function createVersionProblem(response: CreateContainerVersionResponse | undefined): string | undefined {
	if (response?.compilerError) {
		return "GTM could not compile the workspace, so no version was created. Fix the workspace errors in GTM and retry.";
	}
	if (response?.syncStatus?.mergeConflict) {
		return "The workspace has merge conflicts with the latest version. Resolve them in GTM, then retry.";
	}
	if (response?.syncStatus?.syncError) {
		return "GTM could not sync the workspace with the latest version. Retry, or sync it in GTM first.";
	}
	if (!response?.containerVersion) {
		return "No version was created. The workspace may have no changes.";
	}
	return undefined;
}

// ---- Q9: workspace edits are not live --------------------------------------------

/** Q9: append to every successful write so the model doesn't claim a change is live. */
export const UNPUBLISHED_CHANGES_NOTE =
	"This change is saved in the workspace only. It is not live until a version is created (create_version) and a human publishes it in the GTM UI.";
