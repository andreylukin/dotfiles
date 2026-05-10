// Single-file collapse of the former @permissions/local-model package. Only
// the net-glob propose+refine path survived the verb-prompt simplification —
// bash regex/ladder helpers were deleted along with the ladder UI.

import {
	type Api,
	type AssistantMessage,
	complete,
	type Model,
	type TextContent,
} from "@mariozechner/pi-ai";

export interface ModelAuth {
	apiKey?: string;
	headers?: Record<string, string>;
}

export interface ModelOpts {
	model: Model<Api>;
	auth: ModelAuth;
	system: string;
	user: string;
	temperature?: number;
	maxTokens?: number;
	signal?: AbortSignal;
}

export interface NetProposal {
	glob: string;
	reason: string | null;
}

export class ModelUnavailableError extends Error {
	constructor(cause: unknown) {
		super(`model unreachable: ${cause instanceof Error ? cause.message : String(cause)}`);
		this.name = "ModelUnavailableError";
	}
}

const NET_GLOB_PROMPT = `You generate a glob pattern for a network action in a Cedar-style policy.

Action format: net:METHOD:host/path
Glob syntax: * = single path segment (no / no :); ** = anything.

Output ONLY a JSON object:
{"reason": "<one short sentence>", "glob": "net:METHOD:host/path"}

Rules:
- The glob MUST match the input action (caller validates).
- NEVER wildcard the host or scheme. Host stays character-for-character literal.
- Generalize the path tail with /** when the trailing segment is clearly data (e.g. /repos/<owner>/<repo>, /users/<name>, /<package>).
- Stay exact for API entry endpoints (/graphql, /search, /chat/completions), webhook paths with secrets, DELETE methods, and /admin /internal /organization paths.

Examples:
Input: net:GET:api.github.com/repos/foo/bar
{"reason":"Repo path tail is data; host and method literal.","glob":"net:GET:api.github.com/repos/**"}

Input: net:POST:api.linear.app/graphql
{"reason":"GraphQL entry endpoint — no data tail to generalize.","glob":"net:POST:api.linear.app/graphql"}

Input: net:GET:registry.npmjs.org/lodash
{"reason":"Package name is data; host literal.","glob":"net:GET:registry.npmjs.org/**"}`;

function extractText(message: AssistantMessage): string {
	return message.content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("");
}

async function callModel(opts: ModelOpts): Promise<string> {
	let message: AssistantMessage;
	try {
		message = await complete(
			opts.model,
			{
				systemPrompt: opts.system,
				messages: [{ role: "user", content: opts.user, timestamp: Date.now() }],
			},
			{
				apiKey: opts.auth.apiKey,
				headers: opts.auth.headers,
				temperature: opts.temperature ?? 0,
				maxTokens: opts.maxTokens ?? 200,
				signal: opts.signal,
			},
		);
	} catch (e) {
		throw new ModelUnavailableError(e);
	}
	if (message.stopReason === "error") {
		throw new ModelUnavailableError(new Error(message.errorMessage ?? "model error"));
	}
	return extractText(message).trim();
}

function parseNetProposal(content: string): NetProposal | null {
	try {
		const obj = JSON.parse(content) as { glob?: unknown; reason?: unknown };
		if (typeof obj.glob !== "string" || !obj.glob) return null;
		return {
			glob: obj.glob.trim(),
			reason: typeof obj.reason === "string" ? obj.reason.trim() : null,
		};
	} catch {
		return null;
	}
}

async function runNetProposal(
	user: string,
	opts: Omit<ModelOpts, "system" | "user">,
	label: string,
): Promise<NetProposal | null> {
	try {
		const content = await callModel({ ...opts, system: NET_GLOB_PROMPT, user });
		if (!content) return null;
		const parsed = parseNetProposal(content);
		if (!parsed) {
			console.error(
				`[permissions/net-model] could not parse glob (${label}): ${JSON.stringify(content)}`,
			);
			return null;
		}
		return parsed;
	} catch (e) {
		if (e instanceof ModelUnavailableError) {
			console.error(`[permissions/net-model] model unreachable (${label}): ${e.message}`);
			return null;
		}
		console.error(`[permissions/net-model] unexpected error (${label}):`, e);
		return null;
	}
}

export async function proposeNetGlob(
	action: string,
	opts: Omit<ModelOpts, "system" | "user">,
): Promise<NetProposal | null> {
	return runNetProposal(action, opts, "propose-net");
}

export async function refineNetGlob(
	action: string,
	currentGlob: string,
	userFeedback: string,
	opts: Omit<ModelOpts, "system" | "user">,
): Promise<NetProposal | null> {
	const user = [
		`Refine an existing glob based on user feedback.`,
		``,
		`Original action: ${action}`,
		`Current glob: ${currentGlob}`,
		`User wants: ${userFeedback}`,
		``,
		`HARD RULES:`,
		`- The new glob MUST match the original action when expanded (* = single segment, ** = anything).`,
		`- NEVER wildcard the host. Refuse host generalization with a reason.`,
		`- Output prefix must stay net:.`,
		`Output ONLY a JSON object: {"reason":"...","glob":"net:METHOD:host/path"}`,
	].join("\n");
	return runNetProposal(user, opts, "refine-net");
}

/**
 * Translate a Cedar-style glob into a regex.
 * - `**` matches anything (including / and :)
 * - `*`  matches a single segment (no / and no :)
 * Everything else is treated literally (regex-escaped).
 */
export function globToRegex(glob: string): RegExp | null {
	const STAR2 = " DOUBLESTAR ";
	const STAR1 = " SINGLESTAR ";
	const placeheld = glob.replace(/\*\*/g, STAR2).replace(/\*/g, STAR1);
	const escaped = placeheld.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
	const pattern = escaped
		.replace(new RegExp(STAR2, "g"), ".*")
		.replace(new RegExp(STAR1, "g"), "[^/:]*");
	try {
		return new RegExp("^" + pattern + "$");
	} catch {
		return null;
	}
}
