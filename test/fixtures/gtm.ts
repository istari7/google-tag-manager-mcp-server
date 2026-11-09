// Recorded-shape GTM API objects and Google error bodies for pure unit tests.
// Typed with the generated types, so a renamed Google field fails `tsc`.

import type { GoogleErrorBody } from "../../src/gtm/errors";
import type { Folder, Tag, Trigger, Variable } from "../../src/gtm/generated";

export const WORKSPACE = "accounts/1234567890/containers/201/workspaces/7";
export const TAG_PATH = `${WORKSPACE}/tags/12`;
export const TRIGGER_PATH = `${WORKSPACE}/triggers/34`;
export const VARIABLE_PATH = `${WORKSPACE}/variables/56`;
export const FOLDER_PATH = `${WORKSPACE}/folders/9`;

export const ga4EventTag: Tag = {
	accountId: "1234567890",
	containerId: "201",
	workspaceId: "7",
	tagId: "12",
	name: "GA4 - Event - sign_up",
	type: "gaawe",
	path: TAG_PATH,
	fingerprint: "1731100000001",
	parentFolderId: "9",
	notes: "Owned by marketing",
	paused: false,
	firingTriggerId: ["34"],
	blockingTriggerId: ["35"],
	tagFiringOption: "oncePerEvent",
	parameter: [
		{ type: "template", key: "eventName", value: "sign_up" },
		{ type: "tagReference", key: "measurementId", value: "" },
		{ type: "template", key: "measurementIdOverride", value: "{{CONST - GA4 Measurement ID}}" },
	],
	setupTag: [{ tagName: "Consent init", stopOnSetupFailure: true }],
	consentSettings: { consentStatus: "notNeeded" },
	tagManagerUrl: "https://tagmanager.google.com/#/container/accounts/1234567890/containers/201/workspaces/7/tags/12",
};

export const linkClickTrigger: Trigger = {
	accountId: "1234567890",
	containerId: "201",
	workspaceId: "7",
	triggerId: "34",
	name: "Link - Outbound",
	type: "linkClick",
	path: TRIGGER_PATH,
	fingerprint: "1731100000002",
	parentFolderId: "9",
	notes: "Outbound links",
	filter: [
		{
			type: "contains",
			parameter: [
				{ type: "template", key: "arg0", value: "{{Click URL}}" },
				{ type: "template", key: "arg1", value: "http" },
			],
		},
	],
	autoEventFilter: [
		{
			type: "matchRegex",
			parameter: [
				{ type: "template", key: "arg0", value: "{{Page URL}}" },
				{ type: "template", key: "arg1", value: ".*" },
			],
		},
	],
	waitForTags: { type: "boolean", value: "true" },
	checkValidation: { type: "boolean", value: "true" },
	waitForTagsTimeout: { type: "integer", value: "1500" },
	uniqueTriggerId: { type: "template" },
};

export const customEventTrigger: Trigger = {
	triggerId: "40",
	name: "CE - sign_up",
	type: "customEvent",
	path: `${WORKSPACE}/triggers/40`,
	fingerprint: "1731100000003",
	parentFolderId: "9",
	notes: "keep",
	filter: [{ type: "equals", parameter: [{ type: "template", key: "arg0", value: "{{Page Path}}" }] }],
	autoEventFilter: [{ type: "equals" }],
	customEventFilter: [
		{
			type: "equals",
			parameter: [
				{ type: "template", key: "arg0", value: "{{_event}}" },
				{ type: "template", key: "arg1", value: "sign_up" },
			],
		},
	],
	parameter: [{ type: "template", key: "old", value: "old" }],
	uniqueTriggerId: { type: "template" },
};

export const dlvVariable: Variable = {
	variableId: "56",
	name: "DLV - user_id",
	type: "v",
	path: VARIABLE_PATH,
	fingerprint: "1731100000004",
	parentFolderId: "9",
	notes: "From the login push",
	parameter: [
		{ type: "integer", key: "dataLayerVersion", value: "2" },
		{ type: "boolean", key: "setDefaultValue", value: "false" },
		{ type: "template", key: "name", value: "user_id" },
	],
};

export const folder: Folder = {
	folderId: "9",
	name: "Marketing",
	notes: "",
	path: FOLDER_PATH,
	fingerprint: "1731100000005",
};

// ---- Google error bodies ------------------------------------------------------

export const errors = {
	rateLimit403: {
		error: {
			code: 403,
			message: "Rate Limit Exceeded",
			errors: [{ message: "Rate Limit Exceeded", domain: "usageLimits", reason: "rateLimitExceeded" }],
			status: "PERMISSION_DENIED",
		},
	},
	userRateLimit403: {
		error: {
			code: 403,
			message: "User Rate Limit Exceeded",
			errors: [{ message: "User Rate Limit Exceeded", domain: "usageLimits", reason: "userRateLimitExceeded" }],
			status: "PERMISSION_DENIED",
		},
	},
	forbidden403: {
		error: {
			code: 403,
			message: "The caller does not have permission",
			errors: [{ message: "The caller does not have permission", domain: "global", reason: "forbidden" }],
			status: "PERMISSION_DENIED",
		},
	},
	apiDisabled403: {
		error: {
			code: 403,
			message:
				"Tag Manager API has not been used in project 123 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/tagmanager.googleapis.com/overview?project=123 then retry.",
			status: "PERMISSION_DENIED",
			details: [
				{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED", domain: "googleapis.com" },
			],
		},
	},
	scope403: {
		error: {
			code: 403,
			message: "Request had insufficient authentication scopes.",
			status: "PERMISSION_DENIED",
			details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
		},
	},
	quota403: {
		error: {
			code: 403,
			message: "Daily Limit Exceeded",
			errors: [{ message: "Daily Limit Exceeded", domain: "usageLimits", reason: "dailyLimitExceeded" }],
			status: "PERMISSION_DENIED",
		},
	},
	unauthenticated401: {
		error: {
			code: 401,
			message:
				"Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.",
			status: "UNAUTHENTICATED",
		},
	},
	notFound404: {
		error: {
			code: 404,
			message: "Not Found",
			errors: [{ message: "Not Found", domain: "global", reason: "notFound" }],
			status: "NOT_FOUND",
		},
	},
	fingerprint409: { error: { code: 409, message: "Fingerprint mismatch", status: "ABORTED" } },
	precondition412: { error: { code: 412, message: "Precondition Failed", status: "FAILED_PRECONDITION" } },
	duplicateName400: {
		error: {
			code: 400,
			message: "Found entity with duplicate name: GA4 - Event - sign_up",
			errors: [
				{ message: "Found entity with duplicate name: GA4 - Event - sign_up", domain: "global", reason: "invalid" },
			],
			status: "INVALID_ARGUMENT",
		},
	},
	tooMany429: {
		error: {
			code: 429,
			message: "Resource has been exhausted (e.g. check quota).",
			status: "RESOURCE_EXHAUSTED",
		},
	},
	backend503: { error: { code: 503, message: "The service is currently unavailable.", status: "UNAVAILABLE" } },
} as const satisfies Record<string, GoogleErrorBody>;
