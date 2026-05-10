import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createBashToolDefinition,
	type BashToolCallEvent,
	type EditToolCallEvent,
	type ExtensionAPI,
	type ExtensionContext,
	type WriteToolCallEvent,
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import { Container, Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "typebox";
import { proposeNetGlob, refineNetGlob } from "./src/net-model.js";
import type { Policy, Rule } from "@permissions/shared";
import {
	attachAttributionTracking,
	currentAttribution,
	currentBashToolCallId,
} from "./src/attribution.js";
import { extractActions, findInlineScripts, findRefusedShape, type InlineScript } from "./src/bash-ast.js";
import { connectIpc, type IpcClient } from "./src/ipc.js";
import { getMeta, getOrCreateMeta, type NetMeta } from "./src/metadata.js";
import { renderBashResult } from "./src/render-bash.js";
import {
	capabilityActionString,
	runScript,
	type ScriptCapabilities,
	type ScriptLanguage,
} from "./src/run-script.js";
import { evaluate, evaluateBash, globCovers, lintNetGlob } from "./src/policy.js";
import { appendAudit, type AuditDecision, type AuditSource } from "./src/audit.js";
import {
	formatSession,
	formatTemplates,
	handleAudit,
	handleLoad,
	handleSlice,
	handleUnload,
	type SliceContext,
} from "./src/commands.js";
import { handleChat } from "./src/chat.js";
import { listUserTemplates, listAllTemplates, appendRulesToTemplate, templateExists, writeNewTemplate, loadTemplate } from "./src/template-store.js";
import { runCuratePane, type PaneEvent } from "./src/curate-pane.js";

const PROMPT_CHOICES = [
	"Allow once",
	"Always allow",
	"Deny once",
	"Always deny",
] as const;

const NET_PROMPT_CHOICES = [
	"Allow once",
	"Always allow",
	"Deny once",
	"Always deny",
	"Refine with model…",
] as const;

const C = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	cyan: "\x1b[36m",
	magenta: "\x1b[35m",
};

const PROPOSER_PROVIDER = "anthropic";
const PROPOSER_MODEL_ID = "claude-sonnet-4-6";

interface ModelAuthBundle {
	model: Model<Api>;
	auth: { apiKey?: string; headers?: Record<string, string> };
}

let modelAuthPromise: Promise<ModelAuthBundle> | null = null;

function getModelAuth(ctx: ExtensionContext): Promise<ModelAuthBundle> {
	if (modelAuthPromise) return modelAuthPromise;
	modelAuthPromise = (async () => {
		const model = ctx.modelRegistry.find(PROPOSER_PROVIDER, PROPOSER_MODEL_ID);
		if (!model) {
			throw new Error(
				`model ${PROPOSER_PROVIDER}/${PROPOSER_MODEL_ID} not found in registry`,
			);
		}
		const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!resolved.ok) {
			throw new Error(`auth resolution failed: ${resolved.error}`);
		}
		// ctx.modelRegistry sometimes returns ok with no credentials — fall back
		// to a fresh registry that reads auth.json directly. Mirrors what pi
		// does internally.
		if (!resolved.apiKey && !resolved.headers) {
			const { AuthStorage, ModelRegistry } = await import("@mariozechner/pi-coding-agent");
			const fresh = ModelRegistry.create(AuthStorage.create());
			const fm = fresh.find(PROPOSER_PROVIDER, PROPOSER_MODEL_ID);
			if (!fm) throw new Error(`fresh registry: model ${PROPOSER_MODEL_ID} not found`);
			const fresolved = await fresh.getApiKeyAndHeaders(fm);
			if (fresolved.ok && (fresolved.apiKey || fresolved.headers)) {
				return { model: fm, auth: { apiKey: fresolved.apiKey, headers: fresolved.headers } };
			}
			throw new Error(`no anthropic auth: run \`pi /login anthropic\` (or set ANTHROPIC_API_KEY)`);
		}
		return { model, auth: { apiKey: resolved.apiKey, headers: resolved.headers } };
	})();
	modelAuthPromise.catch(() => {
		modelAuthPromise = null;
	});
	return modelAuthPromise;
}

// All TUI approval prompts (bash ladder, AST pre-prompt, net proxy hold, file
// write) chain through this single promise so only one modal is on screen at
// a time. Without serialization, concurrent ctx.ui.* calls clobber each other.
let approvalChain: Promise<unknown> = Promise.resolve();
function serializeApproval<T>(fn: () => Promise<T>): Promise<T> {
	const next = approvalChain.then(fn, fn);
	approvalChain = next.catch(() => {});
	return next;
}

function formatInlineScriptsBlock(scripts: InlineScript[]): string {
	const PREVIEW = 12;
	const blocks: string[] = [];
	for (const s of scripts) {
		const lines = s.source.split("\n");
		const truncated = lines.length > PREVIEW;
		const preview = lines.slice(0, PREVIEW).join("\n");
		const tail = truncated ? `\n${C.dim}… (+${lines.length - PREVIEW} more lines)${C.reset}` : "";
		blocks.push(
			`  ${C.bold}${C.cyan}${s.label}${C.reset} ${C.dim}(inherits outer sandbox: fs clamped to cwd/tmp/cache, net localhost-only)${C.reset}\n${preview}${tail}`,
		);
	}
	return `\n\n${C.bold}${C.cyan}embedded interpreter calls (${scripts.length})${C.reset}:\n${blocks.join("\n")}`;
}

const ScriptCapabilitiesSchema = Type.Object({
	fs: Type.Union([Type.Literal("read-only"), Type.Literal("rw-tmp"), Type.Literal("rw-cwd")], {
		description:
			"Filesystem capability. read-only: no writes anywhere. rw-tmp: writes only to a per-call scratch dir. rw-cwd: writes within the project working directory.",
	}),
	net: Type.Union([Type.Literal("none"), Type.Literal("proxy")], {
		description:
			"Network capability. none: no outbound traffic. proxy: outbound goes through the permissions proxy and is host-gated like normal tools.",
	}),
});

const ScriptInputSchema = Type.Object({
	language: Type.Union([Type.Literal("python"), Type.Literal("node"), Type.Literal("bash")], {
		description: "Interpreter for the script body.",
	}),
	source: Type.String({
		description:
			"Full source code. The script is written to a tmp file and executed under a nested macOS sandbox profile derived from `capabilities`.",
	}),
	args: Type.Optional(
		Type.Array(Type.String(), { description: "argv passed after the script path." }),
	),
	stdin: Type.Optional(Type.String({ description: "Stdin piped into the script." })),
	capabilities: ScriptCapabilitiesSchema,
});

const BashScriptParametersSchema = Type.Object({
	command: Type.Optional(
		Type.String({
			description:
				"A shell command. Use for read-only inspection (git status, ls, cat, grep, find) and pre-approved verbs. Do NOT use this for `python -c`, `node -e`, `bash -c`, eval, base64-pipe-to-shell — use `script` instead.",
		}),
	),
	timeout: Type.Optional(
		Type.Number({ description: "Timeout in seconds for `command` (existing bash semantics)." }),
	),
	script: Type.Optional(ScriptInputSchema),
	scriptTimeout: Type.Optional(
		Type.Number({ description: "Timeout in seconds for `script` (default 60)." }),
	),
});
type BashScriptParameters = Static<typeof BashScriptParametersSchema>;
type ScriptInput = Static<typeof ScriptInputSchema>;

const BASH_PROMPT_SNIPPET =
	'bash({command}) for read-only inspection (no -c/-e/eval). bash({script: {language, source, capabilities: {fs, net}}}) for any code execution, pipelines, or computation. fs: "read-only" | "rw-tmp" | "rw-cwd". net: "none" | "proxy".';

const BASH_GUIDELINES = [
	"Never embed code in `command` via `-c` / `-e` / `eval` / `source` / base64-pipe-to-shell. Use `bash({script: ...})` with structured `language` and `capabilities` instead.",
	"Choose the smallest fs capability that works: prefer `rw-tmp` for ephemeral compute, `rw-cwd` only when the script must mutate project files, `read-only` for pure inspection.",
	"Choose `net: \"none\"` unless the script must reach the network. Network requests still go through the permissions proxy and may prompt the user.",
];

export default async function permissions(pi: ExtensionAPI): Promise<void> {
	attachAttributionTracking(pi);

	const templates: Policy[] = [];
	const sessionPolicy: Policy = { name: "session", rules: [] };
	const allPolicies = (): Policy[] => [...templates, sessionPolicy];

	let resolveCtx!: (ctx: ExtensionContext) => void;
	const ctxPromise = new Promise<ExtensionContext>((res) => {
		resolveCtx = res;
	});
	let ipc: IpcClient | null = null;

	const addSessionRule = (rule: Rule): void => {
		sessionPolicy.rules.push(rule);
		ipc?.addRule({ effect: rule.effect, pattern: rule.pattern });
	};

	pi.on("session_start", (_event, ctx) => {
		resolveCtx(ctx);
	});

	// Re-register pi's built-in bash tool with custom call/result rendering.
	// We replace both renderers to avoid the doubled `$ command` line problem
	// (pi calls renderCall many times across the lifecycle and the built-in
	// re-emits its `$ command` line every time, stacking in the scrollback).
	// Custom renderResult builds a Container with: the `$ command` line, an
	// output preview, the elapsed-time line, and our `permissions:` block
	// summarizing what fired during this tool call.
	//
	// renderCall returns an empty Text while partial — pi displays only
	// renderResult once the result is in (there's no "card" without a result
	// for our tool, just the live spinner that pi renders separately).
	//
	// Pi's tool-execution falls back to the built-in renderCall only when ours
	// is `undefined` (tool-execution.js:64 `?? builtIn`), so we have to provide
	// an explicit function — omitting renderCall inherits the built-in.
	const builtinBash = createBashToolDefinition(process.cwd());
	pi.registerTool<typeof BashScriptParametersSchema>({
		name: builtinBash.name,
		label: builtinBash.label,
		description:
			(builtinBash.description ?? "Run a shell command.") +
			"\n\nThis tool accepts EITHER `command` (string, traditional shell — use only for inspection and pre-approved verbs) OR `script` (structured: language + source + capabilities — use for any code execution). Exactly one must be provided.",
		promptSnippet: BASH_PROMPT_SNIPPET,
		promptGuidelines: BASH_GUIDELINES,
		parameters: BashScriptParametersSchema,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			if (params.script && params.command) {
				return errorResult("bash: provide either `command` or `script`, not both.");
			}
			if (params.script) {
				const timeoutMs = (params.scriptTimeout ?? 60) * 1000;
				const result = await runScript(params.script, {
					cwd: ctx.cwd,
					signal,
					timeoutMs,
				});
				const lang = params.script.language;
				const caps = params.script.capabilities;
				const header = `[script ${lang} fs=${caps.fs} net=${caps.net}] exit=${result.exitCode ?? "killed"}${result.timedOut ? " (timed out)" : ""}`;
				const body = [
					header,
					result.stdout ? `--- stdout ---\n${result.stdout}` : "",
					result.stderr ? `--- stderr ---\n${result.stderr}` : "",
				]
					.filter(Boolean)
					.join("\n");
				return {
					content: [{ type: "text", text: body }],
					isError: result.timedOut || (result.exitCode !== 0 && result.exitCode !== null),
					details: undefined,
				};
			}
			if (typeof params.command === "string" && params.command.length > 0) {
				return builtinBash.execute(
					toolCallId,
					{ command: params.command, timeout: params.timeout },
					signal,
					onUpdate as never,
					ctx,
				);
			}
			return errorResult("bash: must provide either `command` or `script`.");
		},
		renderCall: (_args, _theme, context) => {
			const state = context.state as { startedAt?: number };
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
			}
			const text =
				context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText("");
			return text;
		},
		renderResult: (result, options, theme, context) => {
			const state = context.state as { startedAt?: number; endedAt?: number };
			if (state.startedAt !== undefined && !options.isPartial && state.endedAt === undefined) {
				state.endedAt = Date.now();
			}
			const container =
				context.lastComponent instanceof Container ? context.lastComponent : new Container();
			renderBashResult(container, {
				args: context.args as { command?: string; timeout?: number },
				textOutput: extractTextOutput(result.content),
				isError: context.isError,
				isPartial: options.isPartial,
				expanded: options.expanded,
				startedAt: state.startedAt,
				endedAt: state.endedAt,
				meta: getMeta(context.toolCallId),
				theme,
			});
			return container;
		},
	});

	const sliceCtx: SliceContext = {
		session: sessionPolicy,
		templates,
		addRuleToActive: (rule, _policyName) => {
			ipc?.addRule({ effect: rule.effect, pattern: rule.pattern });
		},
		removeRulesFromSession: (indices) => {
			const remove = new Set(indices);
			const removed: Rule[] = [];
			const kept: Rule[] = [];
			sessionPolicy.rules.forEach((r, i) => {
				if (remove.has(i)) removed.push(r);
				else kept.push(r);
			});
			sessionPolicy.rules.length = 0;
			sessionPolicy.rules.push(...kept);
			return removed;
		},
		pushTemplate: (policy) => {
			templates.push(policy);
		},
		removeTemplate: (name) => {
			const idx = templates.findIndex((t) => t.name === name);
			if (idx < 0) return false;
			templates.splice(idx, 1);
			return true;
		},
	};

	pi.registerCommand("permissions", {
		description:
			"Manage permissions: status, sessions, slice, load/unload, chat, audit, templates, export",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "";
			const rest = parts.slice(1);

			if (sub === "" || sub === "curate") {
				await runCurateLoop(ctx, sliceCtx);
				return;
			}
			if (sub === "status") {
				ctx.ui.notify(formatStatus(templates, sessionPolicy), "info");
				return;
			}
			if (sub === "sessions" || sub === "session") {
				ctx.ui.notify(formatSession(sessionPolicy, templates), "info");
				return;
			}
			if (sub === "templates") {
				const userNames = await listUserTemplates();
				ctx.ui.notify(formatTemplates(templates, userNames), "info");
				return;
			}
			if (sub === "slice") {
				await handleSlice(rest, ctx, sliceCtx);
				return;
			}
			if (sub === "load") {
				await handleLoad(rest, ctx, sliceCtx);
				return;
			}
			if (sub === "unload") {
				handleUnload(rest, ctx, sliceCtx);
				return;
			}
			if (sub === "audit") {
				handleAudit(rest, ctx);
				return;
			}
			if (sub === "chat") {
				await handleChat(rest, ctx, sliceCtx, () => getModelAuth(ctx));
				return;
			}
			if (sub === "export") {
				const name = rest.join(" ").trim();
				if (!name) {
					ctx.ui.notify("usage: /permissions export <name>", "warning");
					return;
				}
				const out = await exportTemplate(name, sessionPolicy);
				ctx.ui.notify(`exported ${sessionPolicy.rules.length} rules to ${out}`, "info");
				return;
			}
			ctx.ui.notify(
				`unknown subcommand: ${sub}\nusage: /permissions [status | sessions | templates | slice <idx> <move|new> <name> | load <name> | unload <name> | audit | chat <q> | export <name>]`,
				"warning",
			);
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash") {
			const input = event.input as Partial<BashScriptParameters>;
			if (input.script) {
				return handleScript(
					event.toolCallId,
					input.script,
					ctx,
					allPolicies,
					addSessionRule,
				);
			}
			if (typeof input.command === "string" && input.command.length > 0) {
				return handleBash(event as BashToolCallEvent, ctx, allPolicies, addSessionRule);
			}
			return { block: true, reason: "bash: must provide either `command` or `script`." };
		}
		if (event.toolName === "write" || event.toolName === "edit") {
			return handleFileWrite(
				event as WriteToolCallEvent | EditToolCallEvent,
				ctx,
				allPolicies,
				addSessionRule,
			);
		}
	});

	const sock = process.env.PI_PERMISSIONS_SOCK;
	if (!sock) return;

	ipc = await connectIpc(sock, {
		onInit: (msg) => {
			templates.length = 0;
			for (const t of msg.templates) {
				templates.push({ name: t.name, rules: [...t.rules] });
			}
		},
		onDecide: async (req) => {
			const ctx = await ctxPromise;
			return decide(ctx, req.action, allPolicies, addSessionRule);
		},
		onAudit: (msg) => {
			const bashId = currentBashToolCallId();
			if (!bashId) return;
			pushNetMeta(bashId, {
				action: msg.action,
				source: msg.decision === "allow" ? "existing" : "denied",
				glob: msg.matchedPattern ?? null,
				policy: msg.matchedPolicy ?? null,
				effect: msg.matchedEffect ?? null,
			});
		},
	});
}

const HIGH_RISK_VERBS = new Set([
	"rm", "rmdir", "mv", "cp", "dd", "shred",
	"chmod", "chown", "chgrp",
	"sudo", "doas", "su",
	"mkfs", "fdisk", "parted", "mount", "umount",
	"kill", "killall", "pkill",
	"systemctl", "service",
	"reboot", "shutdown", "halt", "poweroff",
	"tee",
]);

function firstWord(command: string): string {
	return command.trimStart().split(/\s+/, 1)[0] ?? "";
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function handleBash(
	event: BashToolCallEvent,
	ctx: ExtensionContext,
	allPolicies: () => Policy[],
	addRule: (r: Rule) => void,
): Promise<{ block: true; reason: string } | undefined> {
	const command = (event.input as { command?: unknown }).command;
	if (typeof command !== "string" || command.length === 0) return undefined;
	const toolCallId = event.toolCallId;

	// 1. Refuse bare eval/source/. shapes — there's no isolable body to sandbox.
	const refused = await findRefusedShape(command).catch(() => null);
	if (refused) {
		getOrCreateMeta(toolCallId).bashSegments.push({
			segment: command, source: "denied", regex: null, policy: null, effect: null,
		});
		auditEvent("bash", `bash:${command}`, "deny", "denied", null, null, toolCallId);
		return {
			block: true,
			reason: `bash: \`${refused}\` is not allowed in \`command\`. Use bash({script: {language, source, capabilities: {fs, net}}}) for code execution.`,
		};
	}

	// 1b. Detect inline interpreter calls (`python -c`, `node -e`, `sh -c`).
	// We don't refuse these — instead we rewrite the command at execution
	// time to wrap the interpreter call in `sandbox-exec -f <profile>` with
	// fs=read-only, net=none. The user sees the embedded source bodies in the
	// approval card; saving "Always allow `verb`" is safe because future runs
	// keep the same kernel-level clamp on whatever code the model writes.
	const inlineScripts = await findInlineScripts(command).catch(() => []);

	// 2. Check existing rules (forbid > permit > default-deny via evaluateBash).
	const result = evaluateBash([command], allPolicies());
	if (result.decision === "deny" && result.matchedRule?.effect === "forbid") {
		getOrCreateMeta(toolCallId).bashSegments.push({
			segment: command,
			source: "denied",
			regex: result.matchedRule.pattern.replace(/^bash:/, ""),
			policy: result.matchedPolicy ?? null,
			effect: "forbid",
		});
		auditEvent("bash", `bash:${command}`, "deny", "denied", result.matchedRule.pattern, result.matchedPolicy ?? null, toolCallId);
		return { block: true, reason: `permissions: ${result.reason}` };
	}
	if (result.decision === "allow") {
		getOrCreateMeta(toolCallId).bashSegments.push({
			segment: command,
			source: "existing",
			regex: result.matchedRule?.pattern.replace(/^bash:/, "") ?? null,
			policy: result.matchedPolicy ?? null,
			effect: "permit",
		});
		auditEvent("bash", `bash:${command}`, "allow", "existing", result.matchedRule?.pattern ?? null, result.matchedPolicy ?? null, toolCallId);
	} else {
		// 3. Verb-level approval prompt.
		const verb = firstWord(command);
		const allowAlways = `Always allow \`${verb}\``;
		const denyAlways = `Always deny \`${verb}\``;
		const choice = await serializeApproval(async () => {
			const recheck = evaluateBash([command], allPolicies());
			if (recheck.decision === "allow") return "Allow once" as string;
			if (recheck.decision === "deny" && recheck.matchedRule?.effect === "forbid") {
				return "Deny once" as string;
			}
			const badge = HIGH_RISK_VERBS.has(verb)
				? ` ${C.bold}${C.red}[HIGH RISK]${C.reset}`
				: "";
			const inlineBlock = inlineScripts.length > 0 ? formatInlineScriptsBlock(inlineScripts) : "";
			return ctx.ui.select(
				`${C.bold}${C.magenta}Permission (bash)${C.reset}\n\n  ${C.dim}$${C.reset} ${command}\n  ${C.dim}verb:${C.reset} ${verb}${badge}${inlineBlock}`,
				["Allow once", allowAlways, "Deny once", denyAlways],
			);
		});

		if (!choice || choice === "Deny once") {
			getOrCreateMeta(toolCallId).bashSegments.push({
				segment: command, source: "once-deny", regex: null, policy: null, effect: null,
			});
			auditEvent("bash", `bash:${command}`, "deny", "once-deny", null, null, toolCallId);
			return { block: true, reason: `denied: ${command}` };
		}
		if (choice === "Allow once") {
			getOrCreateMeta(toolCallId).bashSegments.push({
				segment: command, source: "once-allow", regex: null, policy: null, effect: null,
			});
			auditEvent("bash", `bash:${command}`, "allow", "once-allow", null, null, toolCallId);
		} else if (choice === allowAlways) {
			const pattern = `bash:^${escapeRe(verb)}( .*)?$`;
			addRule({ effect: "permit", pattern });
			getOrCreateMeta(toolCallId).bashSegments.push({
				segment: command, source: "added",
				regex: pattern.replace(/^bash:/, ""), policy: "session", effect: "permit",
			});
			auditEvent("bash", `bash:${command}`, "allow", "added", pattern, "session", toolCallId);
		} else if (choice === denyAlways) {
			const pattern = `bash:^${escapeRe(verb)}( .*)?$`;
			addRule({ effect: "forbid", pattern });
			getOrCreateMeta(toolCallId).bashSegments.push({
				segment: command, source: "added",
				regex: pattern.replace(/^bash:/, ""), policy: "session", effect: "forbid",
			});
			auditEvent("bash", `bash:${command}`, "deny", "added", pattern, "session", toolCallId);
			return { block: true, reason: `denied (always): ${verb}` };
		}
	}

	// 3b. Visibility-only: record detected inline interpreter calls in meta so
	// the renderResult shows what executed. Enforcement is the outer sandbox.
	if (inlineScripts.length > 0) {
		for (const s of inlineScripts) {
			getOrCreateMeta(toolCallId).bashSegments.push({
				segment: `${s.label}: inherits outer sandbox (fs cwd+tmp+cache, net localhost-only)`,
				source: "existing",
				regex: null,
				policy: null,
				effect: "permit",
			});
		}
	}

	// 4. Net pre-prompt — extract URLs from curl/wget/git, gate each.
	const extracted = await extractActions(command).catch(() => null);
	if (!extracted || extracted.actions.length === 0) return;

	for (const { action } of extracted.actions) {
		const policiesSnapshot = allPolicies();
		const result = evaluate(action, policiesSnapshot);
		if (result.decision === "deny" && result.matchedRule?.effect === "forbid") {
			pushNetMeta(event.toolCallId, {
				action,
				source: "denied",
				glob: result.matchedRule.pattern,
				policy: result.matchedPolicy ?? null,
				effect: "forbid",
			});
			auditEvent("bash", action, "deny", "denied", result.matchedRule.pattern, result.matchedPolicy ?? null, event.toolCallId);
			return { block: true, reason: `permissions: ${result.reason}` };
		}
		if (result.decision === "allow") {
			pushNetMeta(event.toolCallId, {
				action,
				source: "existing",
				glob: result.matchedRule?.pattern ?? null,
				policy: result.matchedPolicy ?? null,
				effect: "permit",
			});
			auditEvent("bash", action, "allow", "existing", result.matchedRule?.pattern ?? null, result.matchedPolicy ?? null, event.toolCallId);
			continue;
		}

		// Re-check under the approval lock; an earlier prompt may have added a
		// covering rule while we were queued.
		const choice = await serializeApproval(async () => {
			const recheck = evaluate(action, allPolicies());
			if (recheck.decision === "allow") return "Allow" as const;
			if (recheck.decision === "deny" && recheck.matchedRule?.effect === "forbid") {
				return "Deny" as const;
			}
			return ctx.ui.select(
				`Permission (pre-execution): ${action}\ntool:bash`,
				["Allow", "Deny"],
			);
		});
		if (choice !== "Allow") {
			pushNetMeta(event.toolCallId, {
				action,
				source: "once-deny",
				glob: null,
				policy: null,
				effect: null,
			});
			auditEvent("bash", action, "deny", "once-deny", null, null, event.toolCallId);
			return { block: true, reason: `blocked pre-execution: ${action}` };
		}
		const pattern = generalizeNet(action);
		addRule({ effect: "permit", pattern });
		pushNetMeta(event.toolCallId, {
			action,
			source: "added",
			glob: pattern,
			policy: "session",
			effect: "permit",
		});
		auditEvent("bash", action, "allow", "added", pattern, "session", event.toolCallId);
	}
}

async function runCurateLoop(
	ctx: ExtensionContext,
	sctx: SliceContext,
): Promise<void> {
	let state = { cursor: 0, selected: [] as number[] };
	while (true) {
		const available = await listAllTemplates();
		const event: PaneEvent = await runCuratePane(
			ctx,
			sctx.session.rules,
			sctx.templates,
			available,
			{ cursor: state.cursor, selected: new Set(state.selected) },
		);
		if (event.kind === "quit") return;
		// Persist navigation state across re-opens.
		state = { cursor: event.cursor, selected: event.selected };

		if (event.kind === "move") {
			const userTemplates = await listUserTemplates();
			const hint = userTemplates.length > 0 ? `existing: ${userTemplates.join(", ")}` : "(no existing user templates yet)";
			const target = (await ctx.ui.input(`Move ${event.indices.length} rule(s) → template name`, hint))?.trim();
			if (!target) continue;
			const selectedRules = event.indices.map((i) => sctx.session.rules[i]).filter(Boolean);
			if (await templateExists(target)) {
				await appendRulesToTemplate(target, selectedRules);
			} else {
				await writeNewTemplate(target, selectedRules);
			}
			sctx.removeRulesFromSession(event.indices);
			const policy = await loadTemplate(target);
			const existed = sctx.removeTemplate(target);
			sctx.pushTemplate(policy);
			if (!existed) for (const r of policy.rules) sctx.addRuleToActive(r, target);
			state.selected = [];
			ctx.ui.notify(`moved ${selectedRules.length} rule(s) → ${target}`, "info");
			continue;
		}
		if (event.kind === "new") {
			const target = (await ctx.ui.input(`New template name`, "kebab-case is conventional"))?.trim();
			if (!target) continue;
			if (await templateExists(target)) {
				ctx.ui.notify(`template "${target}" already exists — pick a different name or use 'm' to append`, "warning");
				continue;
			}
			const selectedRules = event.indices.map((i) => sctx.session.rules[i]).filter(Boolean);
			await writeNewTemplate(target, selectedRules);
			sctx.removeRulesFromSession(event.indices);
			const policy = await loadTemplate(target);
			sctx.pushTemplate(policy);
			for (const r of policy.rules) sctx.addRuleToActive(r, target);
			state.selected = [];
			ctx.ui.notify(`created ${target} with ${selectedRules.length} rule(s)`, "info");
			continue;
		}
		if (event.kind === "chat") {
			const question = (await ctx.ui.input("Ask the LLM about your permissions", 'e.g. "split these into per-language profiles"'))?.trim();
			if (!question) continue;
			await handleChat([question], ctx, sctx, () => getModelAuth(ctx));
			state.selected = [];
			continue;
		}
		if (event.kind === "delete") {
			const ok = await ctx.ui.confirm(
				`Drop ${event.indices.length} rule(s) from session?`,
				"They are removed from the in-memory session policy. Rules already pushed to the proxy stay in effect this session; restart to fully clear.",
			);
			if (!ok) continue;
			sctx.removeRulesFromSession(event.indices);
			state.selected = [];
			ctx.ui.notify(`dropped ${event.indices.length} rule(s)`, "info");
			continue;
		}
		if (event.kind === "toggle-template") {
			if (event.loaded) {
				sctx.removeTemplate(event.name);
				ctx.ui.notify(`unloaded ${event.name} (rules already in proxy stay until restart)`, "info");
			} else {
				try {
					const policy = await loadTemplate(event.name);
					sctx.removeTemplate(event.name);
					sctx.pushTemplate(policy);
					for (const r of policy.rules) sctx.addRuleToActive(r, event.name);
					ctx.ui.notify(`loaded ${event.name} (${policy.rules.length} rule${policy.rules.length === 1 ? "" : "s"})`, "info");
				} catch (e) {
					ctx.ui.notify(`load failed: ${(e as Error).message}`, "error");
				}
			}
			continue;
		}
	}
}

function pushNetMeta(toolCallId: string, meta: NetMeta): void {
	getOrCreateMeta(toolCallId).netActions.push(meta);
}

function auditEvent(
	tool: string,
	action: string,
	decision: AuditDecision,
	source: AuditSource,
	rule: string | null,
	template: string | null,
	toolCallId?: string,
): void {
	appendAudit({ tool, action, decision, source, rule, template, toolCallId });
}

function errorResult(message: string): {
	content: [{ type: "text"; text: string }];
	isError: true;
	details: undefined;
} {
	return { content: [{ type: "text", text: message }], isError: true, details: undefined };
}

function extractTextOutput(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && "type" in block && block.type === "text") {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("\n");
}

async function handleFileWrite(
	event: WriteToolCallEvent | EditToolCallEvent,
	ctx: ExtensionContext,
	allPolicies: () => Policy[],
	addRule: (r: Rule) => void,
) {
	const inputPath = event.input.path;
	const absPath = toAbsolute(inputPath, ctx.cwd);
	const action = `file:write:${absPath}`;

	const result = evaluate(action, allPolicies());
	if (result.decision === "deny" && result.matchedRule?.effect === "forbid") {
		auditEvent(event.toolName, action, "deny", "denied", result.matchedRule.pattern, result.matchedPolicy ?? null);
		return { block: true, reason: `permissions: ${result.reason}` };
	}
	if (result.decision === "allow") {
		auditEvent(event.toolName, action, "allow", "existing", result.matchedRule?.pattern ?? null, result.matchedPolicy ?? null);
		return;
	}

	const choice = await serializeApproval(async () => {
		const recheck = evaluate(action, allPolicies());
		if (recheck.decision === "allow") return "Allow once" as const;
		if (recheck.decision === "deny" && recheck.matchedRule?.effect === "forbid") {
			return "Deny once" as const;
		}
		return ctx.ui.select(
			`Permission: ${action}\ntool:${event.toolName}`,
			[...PROMPT_CHOICES],
		);
	});
	if (!choice || choice === "Deny once") {
		auditEvent(event.toolName, action, "deny", "once-deny", null, null);
		return { block: true, reason: `denied: ${action}` };
	}
	if (choice === "Allow once") {
		auditEvent(event.toolName, action, "allow", "once-allow", null, null);
		return;
	}

	const effect = choice === "Always allow" ? "permit" : "forbid";
	addRule({ effect, pattern: action });
	auditEvent(event.toolName, action, effect === "permit" ? "allow" : "deny", "added", action, "session");
	if (effect === "forbid") {
		return { block: true, reason: `denied (always): ${action}` };
	}
}

const SCRIPT_PROMPT_CHOICES = [
	"Allow once",
	"Always allow this capability set",
	"Deny once",
	"Always deny this capability set",
] as const;

async function handleScript(
	_toolCallId: string,
	script: ScriptInput,
	ctx: ExtensionContext,
	allPolicies: () => Policy[],
	addRule: (r: Rule) => void,
): Promise<{ block: true; reason: string } | undefined> {
	const action = capabilityActionString(
		script.language as ScriptLanguage,
		script.capabilities as ScriptCapabilities,
	);

	// Pre-lock evaluation: existing forbid rule short-circuits without prompting.
	const pre = evaluate(action, allPolicies());
	if (pre.decision === "deny" && pre.matchedRule?.effect === "forbid") {
		auditEvent("script", action, "deny", "denied", pre.matchedRule.pattern, pre.matchedPolicy ?? null);
		return { block: true, reason: `permissions: ${pre.reason}` };
	}
	if (pre.decision === "allow") {
		auditEvent("script", action, "allow", "existing", pre.matchedRule?.pattern ?? null, pre.matchedPolicy ?? null);
		return undefined;
	}

	const choice = await serializeApproval(async () => {
		// Recheck under the approval lock — an earlier prompt may have added a
		// matching rule while we were queued.
		const recheck = evaluate(action, allPolicies());
		if (recheck.decision === "allow") return "Allow once" as const;
		if (recheck.decision === "deny" && recheck.matchedRule?.effect === "forbid") {
			return "Deny once" as const;
		}
		return ctx.ui.select(formatScriptPrompt(action, script), [...SCRIPT_PROMPT_CHOICES]);
	});

	if (!choice || choice === "Deny once") {
		auditEvent("script", action, "deny", "once-deny", null, null);
		return { block: true, reason: `denied: ${action}` };
	}
	if (choice === "Allow once") {
		auditEvent("script", action, "allow", "once-allow", null, null);
		return undefined;
	}
	if (choice === "Always allow this capability set") {
		addRule({ effect: "permit", pattern: action });
		auditEvent("script", action, "allow", "added", action, "session");
		return undefined;
	}
	if (choice === "Always deny this capability set") {
		addRule({ effect: "forbid", pattern: action });
		auditEvent("script", action, "deny", "added", action, "session");
		return { block: true, reason: `denied (always): ${action}` };
	}
	return undefined;
}

function formatScriptPrompt(action: string, script: ScriptInput): string {
	const cap = script.capabilities as ScriptCapabilities;
	const SOURCE_PREVIEW_LINES = 30;
	const lines = script.source.split("\n");
	const truncated = lines.length > SOURCE_PREVIEW_LINES;
	const preview = lines.slice(0, SOURCE_PREVIEW_LINES).join("\n");
	const tail = truncated ? `\n${C.dim}… (${lines.length - SOURCE_PREVIEW_LINES} more lines)${C.reset}` : "";
	const argsLine = script.args && script.args.length > 0 ? `\n${C.dim}args:${C.reset} ${script.args.join(" ")}` : "";
	const stdinLine = script.stdin ? `\n${C.dim}stdin:${C.reset} ${truncate(script.stdin, 80)}` : "";
	const fsHint =
		cap.fs === "rw-cwd"
			? `${C.yellow}rw-cwd${C.reset} (can write your project)`
			: cap.fs === "rw-tmp"
				? `${C.green}rw-tmp${C.reset} (scratch dir only)`
				: `${C.green}read-only${C.reset}`;
	const netHint =
		cap.net === "proxy"
			? `${C.yellow}proxy${C.reset} (gated outbound)`
			: `${C.green}none${C.reset}`;
	return [
		`${C.bold}${C.magenta}Permission (script)${C.reset}`,
		``,
		`${C.bold}${C.cyan}capabilities${C.reset}: fs=${fsHint}  net=${netHint}`,
		`${C.bold}${C.cyan}rule pattern${C.reset}: ${action}`,
		argsLine.replace(/^\n/, ""),
		stdinLine.replace(/^\n/, ""),
		``,
		`${C.bold}${C.cyan}${script.language} source${C.reset} (${lines.length} line${lines.length === 1 ? "" : "s"}):`,
		preview + tail,
	]
		.filter((s) => s !== "")
		.join("\n");
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max) + `… (+${s.length - max} chars)`;
}

type NetSource = "proposed" | "rejected" | "unavailable";

interface NetDecision {
	glob: string | null;
	reason: string | null;
	rejectedGlob: string | null;
	source: NetSource;
}

function validateProposedGlob(
	glob: string,
	action: string,
): { ok: true } | { ok: false; reason: string } {
	if (!globCovers(glob, action)) {
		return {
			ok: false,
			reason: `the glob does not match the original action ${JSON.stringify(action)}. Make sure your glob still covers the input when * and ** are expanded.`,
		};
	}
	const lint = lintNetGlob(glob, action);
	if (!lint.ok) {
		return { ok: false, reason: `the glob was flagged as unsafe: ${lint.reason}` };
	}
	return { ok: true };
}

async function proposeNetWithValidation(
	action: string,
	ctx: ExtensionContext,
): Promise<NetDecision> {
	let proposal: { glob: string; reason: string | null } | null;
	try {
		const bundle = await getModelAuth(ctx);
		proposal = await proposeNetGlob(action, bundle);
	} catch (err) {
		console.error(
			`[permissions] net proposal failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		proposal = null;
	}
	if (proposal === null) {
		return { glob: null, reason: null, rejectedGlob: null, source: "unavailable" };
	}
	const v = validateProposedGlob(proposal.glob, action);
	if (v.ok) {
		return { glob: proposal.glob, reason: proposal.reason, rejectedGlob: null, source: "proposed" };
	}
	console.error(
		`[permissions] net proposal rejected: glob=${JSON.stringify(proposal.glob)} action=${JSON.stringify(action)} reason=${v.reason}`,
	);
	return { glob: null, reason: proposal.reason, rejectedGlob: proposal.glob, source: "rejected" };
}

function formatNetPrompt(
	action: string,
	attribution: string,
	d: NetDecision,
): string {
	const sourceTag =
		d.source === "proposed"
			? `${C.dim}(proposed)${C.reset}`
			: d.source === "rejected"
				? `${C.dim}${C.yellow}(model proposal rejected by safety check)${C.reset}`
				: `${C.dim}${C.red}(no proposal — model unreachable)${C.reset}`;
	const reasonLine = d.reason
		? `\n  ${C.dim}reason:${C.reset} ${C.dim}${d.reason}${C.reset}`
		: "";
	const globColor = d.source === "proposed" ? C.green : C.red;
	const globLine = d.glob
		? `\n  ${C.dim}glob:${C.reset}   ${globColor}${d.glob}${C.reset}`
		: `\n  ${C.dim}glob:${C.reset}   ${C.red}(none)${C.reset}`;
	const rejectedLine = d.rejectedGlob
		? `\n  ${C.dim}model wrote (rejected):${C.reset} ${C.yellow}${d.rejectedGlob}${C.reset}`
		: "";
	return [
		`${C.bold}${C.magenta}Permission (net)${C.reset}`,
		``,
		`${C.bold}${C.cyan}action${C.reset}:`,
		`  ${action}`,
		`  ${C.dim}${attribution}${C.reset}`,
		``,
		`${C.bold}${C.cyan}proposal${C.reset} ${sourceTag}:` + reasonLine + globLine + rejectedLine,
	].join("\n");
}

async function refineNetFlow(
	action: string,
	current: NetDecision,
	ctx: ExtensionContext,
): Promise<NetDecision | null> {
	const currentGlob = current.glob ?? current.rejectedGlob ?? generalizeNet(action);
	const feedback = await ctx.ui.input(
		`Refine glob for "${action}"\nCurrent: ${currentGlob}`,
		`e.g. "any path on this host" or "only this exact endpoint"`,
	);
	const trimmed = feedback?.trim();
	if (!trimmed) return null;

	let refined: { glob: string; reason: string | null } | null;
	try {
		const bundle = await getModelAuth(ctx);
		refined = await refineNetGlob(action, currentGlob, trimmed, bundle);
	} catch {
		refined = null;
	}
	if (refined === null) {
		await ctx.ui.notify("Model unavailable for refinement.", "warning");
		return null;
	}

	const v = validateProposedGlob(refined.glob, action);
	if (!v.ok) {
		await ctx.ui.notify(
			`Refined glob rejected by safety check: ${v.reason}\nProposed: ${refined.glob}`,
			"warning",
		);
		return null;
	}

	return {
		glob: refined.glob,
		reason: refined.reason,
		rejectedGlob: null,
		source: "proposed",
	};
}

async function decide(
	ctx: ExtensionContext,
	action: string,
	allPolicies: () => Policy[],
	addRule: (r: Rule) => void,
): Promise<{
	decision: "allow" | "deny";
	attribution: string;
	addRule?: { effect: "permit" | "forbid"; pattern: string };
}> {
	const attribution = currentAttribution();
	const bashId = currentBashToolCallId();

	const record = (meta: NetMeta): void => {
		if (bashId) pushNetMeta(bashId, meta);
		auditEvent(
			"net",
			meta.action,
			meta.effect === "forbid" || meta.source === "denied" || meta.source === "once-deny"
				? "deny"
				: "allow",
			meta.source,
			meta.glob,
			meta.policy,
			bashId,
		);
	};

	return serializeApproval(async () => {
		// Re-evaluate now that we hold the approval lock. An earlier prompt may
		// have added a covering rule for this action while we were queued —
		// crucial for bulk patterns like pi-lens hitting registry.npmjs.org N
		// times: once "Always allow" is saved, calls 2..N short-circuit here
		// without an LLM round-trip.
		const recheck = evaluate(action, allPolicies());
		if (recheck.decision === "allow") {
			record({
				action,
				source: "existing",
				glob: recheck.matchedRule?.pattern ?? null,
				policy: recheck.matchedPolicy ?? null,
				effect: "permit",
			});
			return { decision: "allow" as const, attribution };
		}
		if (recheck.decision === "deny" && recheck.matchedRule?.effect === "forbid") {
			record({
				action,
				source: "denied",
				glob: recheck.matchedRule.pattern,
				policy: recheck.matchedPolicy ?? null,
				effect: "forbid",
			});
			return { decision: "deny" as const, attribution };
		}

		// Only call the proposer model once we know we'll actually prompt.
		let decision = await proposeNetWithValidation(action, ctx);

	while (true) {
		const choice = await ctx.ui.select(
			formatNetPrompt(action, attribution, decision),
			[...NET_PROMPT_CHOICES],
		);

		if (!choice || choice === "Deny once") {
			record({ action, source: "once-deny", glob: null, policy: null, effect: null });
			return { decision: "deny", attribution };
		}
		if (choice === "Allow once") {
			record({ action, source: "once-allow", glob: null, policy: null, effect: null });
			return { decision: "allow", attribution };
		}
		if (choice === "Refine with model…") {
			const refined = await refineNetFlow(action, decision, ctx);
			if (refined !== null) decision = refined;
			continue;
		}

		const verdict = choice === "Always allow" ? "allow" : "deny";
		const effect = choice === "Always allow" ? "permit" : "forbid";

		if (decision.source === "proposed" && decision.glob !== null) {
			addRule({ effect, pattern: decision.glob });
			record({ action, source: "added", glob: decision.glob, policy: "session", effect });
			return {
				decision: verdict,
				attribution,
				addRule: { effect, pattern: decision.glob },
			};
		}

		const why =
			decision.source === "unavailable"
				? "no proposal — model unreachable"
				: "model proposal failed safety check";
		await ctx.ui.notify(
			`No rule saved (${why}). ${verdict === "allow" ? "Allowed" : "Denied"} once.`,
			"warning",
		);
		record({
			action,
			source: verdict === "allow" ? "once-allow" : "once-deny",
			glob: null,
			policy: null,
			effect: null,
		});
		return { decision: verdict, attribution };
	}
	});
}

function generalizeNet(action: string): string {
	if (!action.startsWith("net:")) return action;
	const parts = action.split(":");
	if (parts.length < 3) return action;
	const rest = parts.slice(2).join(":");
	const host = rest.split("/")[0];
	return `net:*:${host}/**`;
}

function toAbsolute(p: string, cwd: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return path.resolve(cwd, p);
}

function formatStatus(templates: Policy[], session: Policy): string {
	const lines: string[] = ["Permissions status:"];
	if (templates.length === 0) {
		lines.push("  Templates: (none)");
	} else {
		lines.push(`  Templates (${templates.length}):`);
		for (const t of templates) {
			const permits = t.rules.filter((r) => r.effect === "permit").length;
			const forbids = t.rules.filter((r) => r.effect === "forbid").length;
			lines.push(`    ${t.name ?? "(unnamed)"}: ${permits} permit, ${forbids} forbid`);
		}
	}
	lines.push(`  Session rules (${session.rules.length}):`);
	for (const r of session.rules) {
		lines.push(`    ${r.effect} "${r.pattern}"`);
	}
	return lines.join("\n");
}

async function exportTemplate(name: string, session: Policy): Promise<string> {
	const dir = path.join(os.homedir(), ".permissions", "templates");
	await fs.mkdir(dir, { recursive: true });
	const out = path.join(dir, `${name}.csp`);
	const lines: string[] = [`@name("${name}")`];
	for (const r of session.rules) {
		lines.push(`${r.effect} (action == "${r.pattern}");`);
	}
	await fs.writeFile(out, `${lines.join("\n")}\n`);
	return out;
}
