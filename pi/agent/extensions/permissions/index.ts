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
import { Container, Text } from "@mariozechner/pi-tui";
import {
	proposeBashRegexLadder,
	proposeNetGlob,
	refineNetGlob,
	streamRefineBashRegex,
	type BashProposal,
} from "@permissions/local-model";
import type { Policy, Rule } from "@permissions/shared";
import {
	attachAttributionTracking,
	currentAttribution,
	currentBashToolCallId,
} from "./src/attribution.js";
import { extractActions, extractSegments, type Segment } from "./src/bash-ast.js";
import { highlightPython } from "./src/highlight.js";
import { connectIpc, type IpcClient } from "./src/ipc.js";
import {
	BashApprovalLadder,
	type LadderRow,
	type ApprovalResult,
	type RowState,
} from "./src/ladder.js";
import {
	getMeta,
	getOrCreateMeta,
	type NetMeta,
} from "./src/metadata.js";
import { renderBashResult } from "./src/render-bash.js";
import {
	bashAction,
	evaluate,
	evaluateBash,
	globCovers,
	lintBashRegex,
	lintNetGlob,
} from "./src/policy.js";

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

interface SegmentDecision {
	segment: Segment;
	display: string;
	regex: string | null;
	reason: string | null;
	rejectedRegex: string | null;
	source: "existing" | "proposed" | "rejected" | "unavailable";
	variants: BashProposal[];
	variantIdx: number;
}

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
	pi.registerTool({
		name: builtinBash.name,
		label: builtinBash.label,
		description: builtinBash.description,
		promptSnippet: builtinBash.promptSnippet,
		parameters: builtinBash.parameters,
		execute: builtinBash.execute,
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

	pi.registerCommand("permissions", {
		description: "Show status or export session-accumulated rules to a template",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [sub, ...rest] = trimmed.split(/\s+/);
			if (sub === "" || sub === "status") {
				ctx.ui.notify(formatStatus(templates, sessionPolicy), "info");
			} else if (sub === "export") {
				const name = rest.join(" ").trim();
				if (!name) {
					ctx.ui.notify("usage: /permissions export <name>", "warning");
					return;
				}
				const out = await exportTemplate(name, sessionPolicy);
				ctx.ui.notify(`exported ${sessionPolicy.rules.length} rules to ${out}`, "info");
			} else {
				ctx.ui.notify(`unknown subcommand: ${sub}. usage: /permissions [status|export <name>]`, "warning");
			}
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash") {
			return handleBash(event as BashToolCallEvent, ctx, allPolicies, addSessionRule);
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
			return decide(ctx, req.action, addSessionRule);
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

async function handleBash(
	event: BashToolCallEvent,
	ctx: ExtensionContext,
	allPolicies: () => Policy[],
	addRule: (r: Rule) => void,
): Promise<{ block: true; reason: string } | undefined> {
	const command = (event.input as { command?: unknown }).command;
	if (typeof command !== "string" || command.length === 0) return undefined;

	const regexResult = await gateRegex(command, ctx, allPolicies, addRule, event.toolCallId);
	if (regexResult) return regexResult;

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
			continue;
		}

		const choice = await ctx.ui.select(
			`Permission (pre-execution): ${action}\ntool:bash`,
			["Allow", "Deny"],
		);
		if (choice !== "Allow") {
			pushNetMeta(event.toolCallId, {
				action,
				source: "once-deny",
				glob: null,
				policy: null,
				effect: null,
			});
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
	}
}

function pushNetMeta(toolCallId: string, meta: NetMeta): void {
	getOrCreateMeta(toolCallId).netActions.push(meta);
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

function regexCovers(regex: string, segment: string): boolean {
	if (!regex) return false;
	try {
		return new RegExp(`^(?:${regex})$`).test(segment);
	} catch {
		return false;
	}
}

function validateProposedRegex(
	regex: string,
	segment: string,
): { ok: true } | { ok: false; reason: string } {
	if (!regexCovers(regex, segment)) {
		return {
			ok: false,
			reason: `the regex does not full-match the original input "${segment}". Make sure your pattern matches the input from start to end.`,
		};
	}
	const lint = lintBashRegex(regex);
	if (!lint.ok) {
		return {
			ok: false,
			reason: `the regex was flagged as too broad: ${lint.reason}`,
		};
	}
	return { ok: true };
}

const LADDER_SIZE = 3;
const LADDER_RETRY_TEMPERATURE = 0.6;

const debug = (msg: string): void => {
	if (process.env.PERMISSIONS_DEBUG_MODEL) console.error(msg);
};

/**
 * Binaries whose invocation is destructive or remote-mutating. For these the
 * ladder collapses to three identical literal-regex copies — the user cannot
 * approve a broadened rule, even with explicit consent. Mirrors STEP 0 of
 * BASH_LADDER_PROMPT but enforced in code because qwen3.5:2b cannot be
 * trusted to follow the prompt rule reliably.
 */
const HARD_LOCK_BINARIES = new Set([
	"rm", "rmdir", "mv", "cp", "dd", "shred",
	"chmod", "chown", "chgrp",
	"sudo", "doas", "su",
	"mkfs", "fdisk", "parted", "mount", "umount",
	"kill", "killall", "pkill",
	"systemctl", "service",
	"reboot", "shutdown", "halt", "poweroff",
	"tee",
]);

function isHardLocked(segment: string): boolean {
	const firstWord = segment.trimStart().split(/\s+/, 1)[0] ?? "";
	if (HARD_LOCK_BINARIES.has(firstWord)) return true;
	// git push targeting a remote ref must stay exact
	if (/^git\s+push(\s|$)/.test(segment)) return true;
	return false;
}

function escapeRegexLiteral(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function literalLadder(segment: string): BashProposal[] {
	const regex = `^${escapeRegexLiteral(segment)}$`;
	const variant: BashProposal = {
		regex,
		reason: "HARD LOCK: destructive or remote-mutating command — kept exact at every level.",
	};
	return [variant, variant, variant];
}

/**
 * Static risk classifier — informational only, does not gate. Drives the
 * [low/medium/HIGH/CRITICAL] badge in the approval widget so the user can
 * prioritize attention. Inspired by Codex CLI #21018.
 *
 * Buckets:
 *   critical  — already HARD_LOCKED (rm, git push, …)
 *   high      — shell interpreter bodies (bash -c / python -c / node -e),
 *               eval / exec / source — these execute arbitrary code so the
 *               regex rule is barely a security boundary
 *   medium    — package installs, builds, tests, container/k8s ops, compilers,
 *               git mutations (commit, checkout, merge)
 *   low       — read-only inspection (cat, ls, grep, find, git status, …)
 */
const HIGH_RISK_INTERPRETERS = new Set(["bash", "sh", "zsh", "fish", "ksh", "dash", "tcsh", "csh"]);
const HIGH_RISK_FLAGS = new Set(["-c", "-lc", "-l", "-e"]);
const HIGH_RISK_BINARIES = new Set(["eval", "exec", "source"]);
const MEDIUM_RISK_BINARIES = new Set([
	"npm", "yarn", "pnpm", "npx", "pip", "pip3", "poetry", "uv", "brew", "cargo",
	"gem", "apt", "apt-get", "go", "bundle", "mvn", "gradle", "docker", "podman",
	"kubectl", "helm", "make", "cmake", "ninja", "bazel", "sbt", "ant", "dotnet",
	"pytest", "jest", "mocha", "vitest", "tsc", "webpack", "vite", "esbuild",
	"rustc", "gcc", "clang", "tox", "deno", "bun", "rake", "rails", "manage.py",
	"alembic", "prisma", "drizzle-kit", "supabase",
]);
const LOW_RISK_BINARIES = new Set([
	"cat", "ls", "pwd", "file", "stat", "wc", "head", "tail", "grep", "rg",
	"find", "fd", "tree", "du", "df", "ps", "whoami", "id", "date", "echo",
	"printf", "true", "false", "which", "whereis", "type", "env", "printenv",
	"uname", "hostname", "uptime", "sort", "uniq", "cut", "awk", "sed", "jq",
	"yq", "tr", "tac", "rev", "column", "fold", "xxd", "od", "md5sum",
	"sha256sum", "basename", "dirname", "realpath", "readlink",
]);
const LOW_RISK_GIT_SUBCMDS = new Set([
	"status", "log", "diff", "show", "branch", "remote", "tag", "ls-files",
	"ls-tree", "describe", "reflog", "blame", "stash", "config", "rev-parse",
	"shortlog",
]);

type RiskLevel = "low" | "medium" | "high" | "critical";

function classifyRisk(segmentText: string, kind: "shell" | "python", locked: boolean): RiskLevel {
	if (locked) return "critical";
	if (kind === "python") return "high"; // body extracted from python -c

	const tokens = segmentText.trim().split(/\s+/);
	const first = tokens[0] ?? "";

	if (HIGH_RISK_BINARIES.has(first)) return "high";
	if (HIGH_RISK_INTERPRETERS.has(first) && tokens.some((t) => HIGH_RISK_FLAGS.has(t))) return "high";
	if ((first === "node" || first === "deno") && tokens.includes("-e")) return "high";
	if ((first === "python" || first === "python3") && tokens.includes("-c")) return "high";
	if ((first === "ruby" || first === "perl") && tokens.includes("-e")) return "high";

	if (first === "git") {
		const sub = tokens[1] ?? "";
		if (LOW_RISK_GIT_SUBCMDS.has(sub)) return "low";
		return "medium";
	}

	if (MEDIUM_RISK_BINARIES.has(first)) return "medium";
	if (LOW_RISK_BINARIES.has(first)) return "low";

	// Unknown command: default to medium so it doesn't get tuned out.
	return "medium";
}

async function proposeLadderWithRetry(
	segment: string,
): Promise<{
	variants: BashProposal[];
	rejectedRegex: string | null;
	source: SegmentDecision["source"];
}> {
	// HARD LOCK fast path: skip the model entirely for destructive or
	// remote-mutating commands. Three identical literal-regex variants — user
	// can only approve the exact command they typed.
	if (isHardLocked(segment)) {
		return { variants: literalLadder(segment), rejectedRegex: null, source: "proposed" };
	}

	// First attempt at temp=0 (deterministic, fast path).
	let first: BashProposal[] | null;
	try {
		first = await proposeBashRegexLadder(segment, LADDER_SIZE);
	} catch {
		first = null;
	}
	if (first === null) {
		return { variants: [], rejectedRegex: null, source: "unavailable" };
	}

	const validated = collectValidVariants(first, segment);
	if (validated.length > 0) {
		return { variants: padToSize(validated, LADDER_SIZE), rejectedRegex: null, source: "proposed" };
	}

	// 0 valid in first pass — retry once at higher temperature for diversity.
	debug(
		`[permissions] ladder first pass produced 0 valid variants; retrying at temp=${LADDER_RETRY_TEMPERATURE}. segment=${JSON.stringify(segment)}`,
	);
	let second: BashProposal[] | null;
	try {
		second = await proposeBashRegexLadder(segment, LADDER_SIZE, {
			temperature: LADDER_RETRY_TEMPERATURE,
		});
	} catch {
		second = null;
	}
	const validatedRetry = second ? collectValidVariants(second, segment) : [];
	if (validatedRetry.length > 0) {
		return {
			variants: padToSize(validatedRetry, LADDER_SIZE),
			rejectedRegex: null,
			source: "proposed",
		};
	}

	const rejectedSample = (second ?? first)[0]?.regex ?? null;
	debug(
		`[permissions] ladder retry also produced 0 valid variants. sample rejected regex=${JSON.stringify(rejectedSample)} segment=${JSON.stringify(segment)}`,
	);
	return { variants: [], rejectedRegex: rejectedSample, source: "rejected" };
}

function collectValidVariants(raw: BashProposal[], segment: string): BashProposal[] {
	const out: BashProposal[] = [];
	for (const v of raw) {
		const ok = validateProposedRegex(v.regex, segment);
		if (!ok.ok) {
			debug(
				`[permissions] ladder variant rejected: regex=${JSON.stringify(v.regex)} reason=${ok.reason}`,
			);
			continue;
		}
		out.push(v);
	}
	return out;
}

function padToSize(variants: BashProposal[], size: number): BashProposal[] {
	if (variants.length === 0) return [];
	if (variants.length >= size) return variants.slice(0, size);
	const padded = [...variants];
	const last = variants[variants.length - 1];
	while (padded.length < size) padded.push(last);
	return padded;
}

interface CoveringRule {
	regex: string;
	policy: string;
}

function findCoveringRule(segText: string, policies: Policy[]): CoveringRule | null {
	for (const policy of policies) {
		for (const rule of policy.rules) {
			if (rule.effect !== "permit") continue;
			if (!rule.pattern.startsWith("bash:")) continue;
			const regex = rule.pattern.slice("bash:".length);
			if (regexCovers(regex, segText)) {
				return { regex, policy: policy.name ?? "(unnamed)" };
			}
		}
	}
	return null;
}

async function buildDisplay(segments: Segment[]): Promise<string[]> {
	return Promise.all(
		segments.map(async (s) => {
			if (s.kind === "python") return highlightPython(s.text);
			if (s.pythonBodyRange) {
				const { start, end } = s.pythonBodyRange;
				return `${s.text.slice(0, start)}${await highlightPython(s.text.slice(start, end))}${s.text.slice(end)}`;
			}
			return s.text;
		}),
	);
}

async function gateRegex(
	command: string,
	ctx: ExtensionContext,
	allPolicies: () => Policy[],
	addRule: (r: Rule) => void,
	toolCallId: string,
): Promise<{ block: true; reason: string } | undefined> {
	const segments = await extractSegments(command).catch((): Segment[] => []);
	if (segments.length === 0) {
		return { block: true, reason: "permissions: failed to parse bash command" };
	}
	const segmentTexts = segments.map((s) => s.text);

	// Forbid + full-coverage check first.
	const policiesSnapshot = allPolicies();
	const result = evaluateBash(segmentTexts, policiesSnapshot);
	if (result.decision === "deny" && result.matchedRule?.effect === "forbid") {
		const meta = getOrCreateMeta(toolCallId);
		for (const s of segments) {
			meta.bashSegments.push({
				segment: s.text,
				source: "denied",
				regex: result.matchedRule.pattern.replace(/^bash:/, ""),
				policy: result.matchedPolicy ?? null,
				effect: "forbid",
			});
		}
		return { block: true, reason: `permissions: ${result.reason}` };
	}
	if (result.decision === "allow") {
		const meta = getOrCreateMeta(toolCallId);
		for (const s of segments) {
			const cover = findCoveringRule(s.text, policiesSnapshot);
			meta.bashSegments.push({
				segment: s.text,
				source: "existing",
				regex: cover?.regex ?? null,
				policy: cover?.policy ?? null,
				effect: cover ? "permit" : null,
			});
		}
		return undefined;
	}

	// Some segments uncovered — propose a 3-variant ladder via local model in parallel.
	const policies = allPolicies();
	type ProposalRow =
		| { kind: "existing"; regex: string }
		| { kind: "ladder"; variants: BashProposal[]; rejectedRegex: string | null; source: SegmentDecision["source"] };
	const proposalsPromise = Promise.all(
		segments.map(async (s): Promise<ProposalRow> => {
			const existing = findCoveringRule(s.text, policies);
			if (existing) return { kind: "existing", regex: existing.regex };
			const r = await proposeLadderWithRetry(s.text);
			return { kind: "ladder", variants: r.variants, rejectedRegex: r.rejectedRegex, source: r.source };
		}),
	);

	const [displays, proposals] = await Promise.all([buildDisplay(segments), proposalsPromise]);
	const decisions: SegmentDecision[] = segments.map((s, i) => {
		const p = proposals[i];
		if (p.kind === "existing") {
			return {
				segment: s,
				display: displays[i],
				regex: p.regex,
				reason: null,
				rejectedRegex: null,
				source: "existing",
				variants: [],
				variantIdx: 0,
			};
		}
		const startIdx = Math.min(1, Math.max(0, p.variants.length - 1));
		return {
			segment: s,
			display: displays[i],
			regex: p.variants[startIdx]?.regex ?? null,
			reason: p.variants[startIdx]?.reason ?? null,
			rejectedRegex: p.rejectedRegex,
			source: p.source,
			variants: p.variants,
			variantIdx: startIdx,
		};
	});

	const rows: LadderRow[] = decisions.map((d) => {
		const kind: "shell" | "python" = d.segment.kind === "python" ? "python" : "shell";
		return {
			segmentText: d.segment.text,
			display: d.display,
			depth: d.segment.depth,
			kind,
			source: d.source,
			existingRegex: d.source === "existing" ? d.regex : null,
			rejectedRegex: d.rejectedRegex,
			variants: d.variants,
			variantIdx: d.variantIdx,
			risk: classifyRisk(d.segment.text, kind, isHardLocked(d.segment.text)),
		};
	});

	const approval = await ctx.ui.custom<ApprovalResult>((tui, theme, _kb, done) =>
		new BashApprovalLadder({
			command,
			rows,
			theme,
			done,
			tui,
			refineFn: async (segmentText, currentRegex, directive, onChunk, signal) => {
				const proposal = await streamRefineBashRegex(
					segmentText,
					currentRegex,
					directive,
					onChunk,
					{ signal },
				);
				if (proposal === null) return null;
				const v = validateProposedRegex(proposal.regex, segmentText);
				if (!v.ok) return { ok: false, reason: v.reason };
				return { ok: true, variant: proposal };
			},
		}),
	);

	// Cancel = deny-once for the whole command. Record all rows as once-deny
	// (existing rows stay existing) and block.
	if (approval.action === "cancel") {
		const meta = getOrCreateMeta(toolCallId);
		for (const d of decisions) {
			meta.bashSegments.push({
				segment: d.segment.text,
				source: d.source === "existing" ? "existing" : "once-deny",
				regex: d.regex,
				policy: d.source === "existing"
					? findCoveringRule(d.segment.text, policiesSnapshot)?.policy ?? null
					: null,
				effect: d.source === "existing" ? "permit" : null,
			});
		}
		const reason = await maybeReason(ctx);
		return { block: true, reason: reason ? `denied: ${reason}` : `denied: bash` };
	}

	// Per-row decisions. Block iff any row decided deny.
	const meta = getOrCreateMeta(toolCallId);
	let blocked = false;
	const denyReasons: string[] = [];
	let fallbackOnce = 0; // always-* rows that fell back to once-* due to no variant
	let rulesAdded = 0;
	for (let i = 0; i < decisions.length; i++) {
		const d = decisions[i];
		const rd = approval.decisions[i];

		if (rd.kind === "existing") {
			meta.bashSegments.push({
				segment: d.segment.text,
				source: "existing",
				regex: d.regex,
				policy: findCoveringRule(d.segment.text, policiesSnapshot)?.policy ?? null,
				effect: "permit",
			});
			continue;
		}
		if (rd.kind === "allow-once") {
			meta.bashSegments.push({
				segment: d.segment.text,
				source: "once-allow",
				regex: null,
				policy: null,
				effect: null,
			});
			continue;
		}
		if (rd.kind === "deny-once") {
			meta.bashSegments.push({
				segment: d.segment.text,
				source: "once-deny",
				regex: null,
				policy: null,
				effect: null,
			});
			blocked = true;
			denyReasons.push(`once: ${d.segment.text}`);
			continue;
		}
		if (rd.kind === "always-allow") {
			if (rd.variant) {
				addRule({ effect: "permit", pattern: bashAction(rd.variant.regex) });
				rulesAdded++;
				meta.bashSegments.push({
					segment: d.segment.text,
					source: "added",
					regex: rd.variant.regex,
					policy: "session",
					effect: "permit",
				});
			} else {
				fallbackOnce++;
				meta.bashSegments.push({
					segment: d.segment.text,
					source: "once-allow",
					regex: null,
					policy: null,
					effect: null,
				});
			}
			continue;
		}
		if (rd.kind === "always-deny") {
			if (rd.variant) {
				addRule({ effect: "forbid", pattern: bashAction(rd.variant.regex) });
				rulesAdded++;
				meta.bashSegments.push({
					segment: d.segment.text,
					source: "added",
					regex: rd.variant.regex,
					policy: "session",
					effect: "forbid",
				});
			} else {
				fallbackOnce++;
				meta.bashSegments.push({
					segment: d.segment.text,
					source: "once-deny",
					regex: null,
					policy: null,
					effect: null,
				});
			}
			blocked = true;
			denyReasons.push(`always: ${d.segment.text}`);
		}
	}

	if (fallbackOnce > 0) {
		await ctx.ui.notify(
			`${fallbackOnce} segment${fallbackOnce === 1 ? "" : "s"} had no proposal — fell back to once-only (no rule saved).`,
			"warning",
		);
	}

	if (blocked) {
		const reason = await maybeReason(ctx);
		const summary = `denied (${rulesAdded} rule${rulesAdded === 1 ? "" : "s"} added, ${denyReasons.length} segment${denyReasons.length === 1 ? "" : "s"} denied)`;
		return { block: true, reason: reason ? `${summary}: ${reason}` : summary };
	}

	return undefined;
}

async function maybeReason(ctx: ExtensionContext): Promise<string | undefined> {
	const text = await ctx.ui.input(
		"Reason for the LLM (optional, blank to skip)",
		"why this was denied / what to do instead",
	);
	const trimmed = text?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
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
		return { block: true, reason: `permissions: ${result.reason}` };
	}
	if (result.decision === "allow") return;

	const choice = await ctx.ui.select(
		`Permission: ${action}\ntool:${event.toolName}`,
		[...PROMPT_CHOICES],
	);
	if (!choice || choice === "Deny once") {
		return { block: true, reason: `denied: ${action}` };
	}
	if (choice === "Allow once") return;

	const effect = choice === "Always allow" ? "permit" : "forbid";
	addRule({ effect, pattern: action });
	if (effect === "forbid") {
		return { block: true, reason: `denied (always): ${action}` };
	}
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

async function proposeNetWithValidation(action: string): Promise<NetDecision> {
	let proposal: { glob: string; reason: string | null } | null;
	try {
		proposal = await proposeNetGlob(action);
	} catch {
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
				: `${C.dim}${C.red}(no proposal — ollama unreachable)${C.reset}`;
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
		refined = await refineNetGlob(action, currentGlob, trimmed);
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
	addRule: (r: Rule) => void,
): Promise<{
	decision: "allow" | "deny";
	attribution: string;
	addRule?: { effect: "permit" | "forbid"; pattern: string };
}> {
	const attribution = currentAttribution();
	const bashId = currentBashToolCallId();
	let decision = await proposeNetWithValidation(action);

	const record = (meta: NetMeta): void => {
		if (bashId) pushNetMeta(bashId, meta);
	};

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
				? "no proposal — likely ollama is unreachable"
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
