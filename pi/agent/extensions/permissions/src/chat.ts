import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Api, AssistantMessage, Model, TextContent } from "@mariozechner/pi-ai";
import { complete } from "@mariozechner/pi-ai";
import type { Rule } from "@permissions/shared";
import { readAudit } from "./audit.js";
import {
	appendRulesToTemplate,
	listUserTemplates,
	loadTemplate,
	templateExists,
	writeNewTemplate,
} from "./template-store.js";
import type { SliceContext } from "./commands.js";

export interface ChatPlan {
	summary?: string;
	moves?: { ruleIndices: number[]; template: string }[];
	creates?: { name: string; ruleIndices: number[] }[];
	edits?: { ruleIndex: number; newPattern: string; newEffect?: "permit" | "forbid" }[];
}

interface ModelAuthBundle {
	model: Model<Api>;
	auth: { apiKey?: string; headers?: Record<string, string> };
}

const SYSTEM_PROMPT = `You are a permissions-policy organizer for a CLI tool that gates network/bash/file operations.

POLICY MODEL
- Each rule has shape: { effect: "permit" | "forbid", pattern: string }
- Pattern syntax (action strings):
  - net:<METHOD>:<host>/<path>   e.g. "net:GET:registry.npmjs.org/express"
  - bash:<regex>                 e.g. "bash:^restish( .*)?$"
  - file:write:<absolute-path>
  - script:lang=<lang>:fs=<cap>:net=<cap>
- Glob: \`*\` matches one path segment, \`**\` matches across segments.
- forbid > permit > default-deny.

GOAL
The user wants help organizing their accumulated session rules. You produce a JSON plan with these operations:
- moves: take session rules at given indices and append them to an existing template.
- creates: take session rules at given indices and put them in a new template file.
- edits: rewrite a session rule's pattern (typically to make it less broad).

Always include a short \`summary\` explaining what you're proposing.
Indices are 1-based, matching what the user sees.
Rules can appear in at most one operation. If unsure, leave a rule out — don't speculatively assign.

OUTPUT
Reply with a single JSON object matching this TS type, and NOTHING ELSE (no markdown fences, no commentary):
{
  "summary": string,
  "moves"?:   { "ruleIndices": number[], "template": string }[],
  "creates"?: { "name": string, "ruleIndices": number[] }[],
  "edits"?:   { "ruleIndex": number, "newPattern": string, "newEffect"?: "permit" | "forbid" }[]
}`;

function formatRulesForPrompt(rules: Rule[]): string {
	return rules
		.map((r, i) => `${i + 1}. ${r.effect} ${r.pattern}`)
		.join("\n");
}

function formatAuditForPrompt(): string {
	const entries = readAudit({ last: 30 });
	if (entries.length === 0) return "(no audit entries)";
	return entries
		.map((e) => `${e.decision} ${e.source} ${e.tool} ${e.action}${e.rule ? ` rule=${e.rule}` : ""}`)
		.join("\n");
}

function tryParsePlan(raw: string): ChatPlan | null {
	const trimmed = raw.trim();
	// Strip ```json fences if model wrapped despite instructions.
	const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
	const candidate = fenced ? fenced[1] : trimmed;
	try {
		return JSON.parse(candidate) as ChatPlan;
	} catch {
		// Try to find the first {...} block.
		const m = candidate.match(/\{[\s\S]*\}/);
		if (m) {
			try {
				return JSON.parse(m[0]) as ChatPlan;
			} catch {
				return null;
			}
		}
		return null;
	}
}

export async function handleChat(
	args: string[],
	ctx: ExtensionContext,
	sctx: SliceContext,
	getModelAuth: () => Promise<ModelAuthBundle>,
): Promise<void> {
	const question = args.join(" ").trim();
	if (!question) {
		ctx.ui.notify(
			'usage: /permissions chat <question>\n  e.g. /permissions chat "split these into per-language profiles"\n       /permissions chat "tighten rule 3 to only scoped npm packages"',
			"warning",
		);
		return;
	}
	if (sctx.session.rules.length === 0) {
		ctx.ui.notify("session is empty — accept some 'Always allow' prompts first.", "info");
		return;
	}

	let bundle: ModelAuthBundle;
	try {
		bundle = await getModelAuth();
	} catch (e) {
		ctx.ui.notify(`model unavailable: ${(e as Error).message}`, "error");
		return;
	}

	const userTemplates = await listUserTemplates();
	const userMessage = [
		`Question: ${question}`,
		"",
		"Session rules (1-based indices):",
		formatRulesForPrompt(sctx.session.rules),
		"",
		`Existing user templates: ${userTemplates.length > 0 ? userTemplates.join(", ") : "(none)"}`,
		`Currently loaded templates: ${sctx.templates.map((t) => t.name).filter(Boolean).join(", ") || "(none)"}`,
		"",
		"Recent audit (last 30 decisions):",
		formatAuditForPrompt(),
	].join("\n");

	let raw: string;
	try {
		const message: AssistantMessage = await complete(
			bundle.model,
			{
				systemPrompt: SYSTEM_PROMPT,
				messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
			},
			{
				apiKey: bundle.auth.apiKey,
				headers: bundle.auth.headers,
				temperature: 0.2,
				maxTokens: 2048,
			},
		);
		if (message.stopReason === "error") {
			ctx.ui.notify(`model error: ${message.errorMessage ?? "unknown"}`, "error");
			return;
		}
		raw = message.content
			.filter((c): c is TextContent => c.type === "text")
			.map((c) => c.text)
			.join("");
	} catch (e) {
		ctx.ui.notify(`model call failed: ${(e as Error).message}`, "error");
		return;
	}

	const plan = tryParsePlan(raw);
	if (!plan) {
		ctx.ui.notify(`couldn't parse plan from model response:\n${raw.slice(0, 500)}`, "error");
		return;
	}

	const preview = formatPlanPreview(plan, sctx.session.rules);
	const ok = await ctx.ui.confirm("Apply this plan?", preview);
	if (!ok) {
		ctx.ui.notify("plan discarded.", "info");
		return;
	}

	await applyPlan(plan, ctx, sctx);
}

function formatPlanPreview(plan: ChatPlan, sessionRules: Rule[]): string {
	const lines: string[] = [];
	if (plan.summary) lines.push(`summary: ${plan.summary}`, "");
	if (plan.creates?.length) {
		lines.push("CREATE:");
		for (const c of plan.creates) {
			lines.push(`  new template "${c.name}":`);
			for (const i of c.ruleIndices) {
				const r = sessionRules[i - 1];
				lines.push(r ? `    [${i}] ${r.effect} ${r.pattern}` : `    [${i}] (out of range)`);
			}
		}
	}
	if (plan.moves?.length) {
		lines.push("MOVE:");
		for (const m of plan.moves) {
			lines.push(`  → ${m.template}:`);
			for (const i of m.ruleIndices) {
				const r = sessionRules[i - 1];
				lines.push(r ? `    [${i}] ${r.effect} ${r.pattern}` : `    [${i}] (out of range)`);
			}
		}
	}
	if (plan.edits?.length) {
		lines.push("EDIT:");
		for (const e of plan.edits) {
			const r = sessionRules[e.ruleIndex - 1];
			if (!r) {
				lines.push(`  [${e.ruleIndex}] (out of range)`);
				continue;
			}
			const oldEff = r.effect;
			const newEff = e.newEffect ?? oldEff;
			lines.push(`  [${e.ruleIndex}] ${oldEff} ${r.pattern}`);
			lines.push(`    → ${newEff} ${e.newPattern}`);
		}
	}
	if (lines.length === 0) lines.push("(empty plan — nothing to apply)");
	return lines.join("\n");
}

async function applyPlan(plan: ChatPlan, ctx: ExtensionContext, sctx: SliceContext): Promise<void> {
	// Apply edits FIRST (mutate in place; doesn't invalidate indices).
	for (const e of plan.edits ?? []) {
		const r = sctx.session.rules[e.ruleIndex - 1];
		if (!r) continue;
		r.pattern = e.newPattern;
		if (e.newEffect) r.effect = e.newEffect;
	}

	// Collect all (1-based) indices removed by moves+creates so we splice once.
	const removedIdx = new Set<number>();
	const groupRemovals: { template: string; isNew: boolean; rules: Rule[] }[] = [];

	for (const c of plan.creates ?? []) {
		const rules = c.ruleIndices
			.map((i) => sctx.session.rules[i - 1])
			.filter((r): r is Rule => !!r);
		if (rules.length === 0) continue;
		if (await templateExists(c.name)) {
			ctx.ui.notify(`skipping create: template "${c.name}" already exists`, "warning");
			continue;
		}
		await writeNewTemplate(c.name, rules);
		groupRemovals.push({ template: c.name, isNew: true, rules });
		for (const i of c.ruleIndices) removedIdx.add(i - 1);
	}

	for (const m of plan.moves ?? []) {
		const rules = m.ruleIndices
			.map((i) => sctx.session.rules[i - 1])
			.filter((r): r is Rule => !!r);
		if (rules.length === 0) continue;
		const isNew = !(await templateExists(m.template));
		if (isNew) {
			await writeNewTemplate(m.template, rules);
		} else {
			await appendRulesToTemplate(m.template, rules);
		}
		groupRemovals.push({ template: m.template, isNew, rules });
		for (const i of m.ruleIndices) removedIdx.add(i - 1);
	}

	if (removedIdx.size > 0) {
		sctx.removeRulesFromSession([...removedIdx].sort((a, b) => a - b));
	}

	// Reload affected templates so their rules apply for the rest of this session.
	for (const g of groupRemovals) {
		const policy = await loadTemplate(g.template);
		const existed = sctx.removeTemplate(g.template);
		sctx.pushTemplate(policy);
		if (!existed) {
			for (const r of policy.rules) sctx.addRuleToActive(r, g.template);
		}
	}

	const summary: string[] = [];
	if ((plan.creates?.length ?? 0) > 0) summary.push(`created ${plan.creates?.length}`);
	if ((plan.moves?.length ?? 0) > 0) summary.push(`moved ${plan.moves?.length}`);
	if ((plan.edits?.length ?? 0) > 0) summary.push(`edited ${plan.edits?.length}`);
	ctx.ui.notify(`plan applied: ${summary.join(", ") || "no-op"}`, "info");
}
