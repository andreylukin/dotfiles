import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Policy, Rule } from "@permissions/shared";
import { countHitsByRule, readAudit } from "./audit.js";
import {
	appendRulesToTemplate,
	listUserTemplates,
	loadTemplate,
	templateExists,
	writeNewTemplate,
} from "./template-store.js";

const C = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	cyan: "\x1b[36m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
};

/** Parse "1,3,5-7,all" against a 1-indexed list. Returns 0-indexed array. */
export function parseIndexSpec(spec: string, max: number): number[] {
	const t = spec.trim().toLowerCase();
	if (t === "all" || t === "*") return Array.from({ length: max }, (_, i) => i);
	const out = new Set<number>();
	for (const part of t.split(",")) {
		const p = part.trim();
		if (!p) continue;
		const range = p.match(/^(\d+)\s*-\s*(\d+)$/);
		if (range) {
			const a = Number.parseInt(range[1], 10);
			const b = Number.parseInt(range[2], 10);
			for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
				if (i >= 1 && i <= max) out.add(i - 1);
			}
		} else {
			const n = Number.parseInt(p, 10);
			if (Number.isFinite(n) && n >= 1 && n <= max) out.add(n - 1);
		}
	}
	return [...out].sort((a, b) => a - b);
}

export function formatSession(session: Policy, templates: Policy[]): string {
	const hits = countHitsByRule(session.rules);
	const lines: string[] = [
		`${C.bold}${C.cyan}session${C.reset} (${session.rules.length} rule${session.rules.length === 1 ? "" : "s"})`,
	];
	if (session.rules.length === 0) {
		lines.push(`  ${C.dim}(empty — accept "Always allow" prompts to populate)${C.reset}`);
	}
	session.rules.forEach((r, i) => {
		const hitCount = hits.get(r.pattern) ?? 0;
		const hitStr = hitCount > 0 ? `${C.dim}hits:${hitCount}${C.reset}` : `${C.dim}hits:0${C.reset}`;
		const eff = r.effect === "permit" ? `${C.green}permit${C.reset}` : `${C.red}forbid${C.reset}`;
		lines.push(`  ${C.bold}${(i + 1).toString().padStart(2)}${C.reset}  ${eff}  ${r.pattern}  ${hitStr}`);
	});
	if (templates.length > 0) {
		lines.push("", `${C.bold}${C.cyan}loaded templates${C.reset}:`);
		for (const t of templates) {
			lines.push(`  ${t.name ?? "(unnamed)"} (${t.rules.length} rule${t.rules.length === 1 ? "" : "s"})`);
		}
	}
	return lines.join("\n");
}

export function formatTemplates(templates: Policy[], userNames: string[]): string {
	const loadedNames = new Set(templates.map((t) => t.name).filter((n): n is string => !!n));
	const lines: string[] = [`${C.bold}${C.cyan}user templates${C.reset} (~/.permissions/templates):`];
	if (userNames.length === 0) {
		lines.push(`  ${C.dim}(none)${C.reset}`);
	} else {
		for (const n of userNames) {
			const tag = loadedNames.has(n) ? `${C.green}[loaded]${C.reset}` : `${C.dim}[available]${C.reset}`;
			lines.push(`  ${n}  ${tag}`);
		}
	}
	const bundled = templates.filter((t) => !!t.name && !userNames.includes(t.name));
	if (bundled.length > 0) {
		lines.push("", `${C.bold}${C.cyan}bundled / startup-loaded${C.reset}:`);
		for (const t of bundled) lines.push(`  ${t.name} (${t.rules.length})`);
	}
	return lines.join("\n");
}

export interface SliceContext {
	session: Policy;
	templates: Policy[];
	addRuleToActive: (rule: Rule, policyName: string) => void;
	removeRulesFromSession: (indices: number[]) => Rule[];
	pushTemplate: (policy: Policy) => void;
	removeTemplate: (name: string) => boolean;
}

export async function handleSlice(
	args: string[],
	ctx: ExtensionContext,
	sctx: SliceContext,
): Promise<void> {
	if (args.length < 3) {
		ctx.ui.notify(
			"usage: /permissions slice <indices> <move|new> <template-name>\n  e.g. /permissions slice 1,3,5-7 move pi-base\n  e.g. /permissions slice 2,4 new my-tools",
			"warning",
		);
		return;
	}
	const [spec, op, ...rest] = args;
	const target = rest.join(" ").trim();
	if (!target) {
		ctx.ui.notify("missing template name", "warning");
		return;
	}
	const indices = parseIndexSpec(spec, sctx.session.rules.length);
	if (indices.length === 0) {
		ctx.ui.notify(`no rules selected by "${spec}"`, "warning");
		return;
	}
	const selectedRules = indices.map((i) => sctx.session.rules[i]);
	const preview = selectedRules.map((r, i) => `  ${i + 1}. ${r.effect} ${r.pattern}`).join("\n");

	if (op === "move") {
		if (!(await templateExists(target))) {
			const create = await ctx.ui.confirm(
				`template "${target}" doesn't exist. Create it?`,
				`Will create ~/.permissions/templates/${target}.csp with ${selectedRules.length} rule(s).`,
			);
			if (!create) return;
			await writeNewTemplate(target, selectedRules);
		} else {
			const ok = await ctx.ui.confirm(
				`Move ${selectedRules.length} rule(s) → ${target}?`,
				`Will append to ~/.permissions/templates/${target}.csp:\n${preview}`,
			);
			if (!ok) return;
			await appendRulesToTemplate(target, selectedRules);
		}
		const removed = sctx.removeRulesFromSession(indices);
		await reloadAndApplyTemplate(target, sctx);
		ctx.ui.notify(
			`moved ${removed.length} rule(s) from session → ${target}`,
			"info",
		);
	} else if (op === "new") {
		if (await templateExists(target)) {
			ctx.ui.notify(
				`template "${target}" already exists. Use 'move' to append, or pick a different name.`,
				"warning",
			);
			return;
		}
		const ok = await ctx.ui.confirm(
			`Create new template "${target}" with ${selectedRules.length} rule(s)?`,
			preview,
		);
		if (!ok) return;
		await writeNewTemplate(target, selectedRules);
		const removed = sctx.removeRulesFromSession(indices);
		await reloadAndApplyTemplate(target, sctx);
		ctx.ui.notify(
			`created template ${target} with ${removed.length} rule(s)`,
			"info",
		);
	} else {
		ctx.ui.notify(`unknown op "${op}". use 'move' or 'new'.`, "warning");
	}
}

async function reloadAndApplyTemplate(name: string, sctx: SliceContext): Promise<void> {
	const policy = await loadTemplate(name);
	// Replace if loaded; otherwise add.
	const existed = sctx.removeTemplate(name);
	sctx.pushTemplate(policy);
	if (!existed) {
		// Re-fire each rule into the proxy via addRuleToActive so net rules
		// take effect immediately mid-session.
		for (const r of policy.rules) sctx.addRuleToActive(r, name);
	}
}

export async function handleLoad(
	args: string[],
	ctx: ExtensionContext,
	sctx: SliceContext,
): Promise<void> {
	const name = args.join(" ").trim();
	if (!name) {
		const userNames = await listUserTemplates();
		ctx.ui.notify(
			`usage: /permissions load <name>\navailable: ${userNames.join(", ") || "(none in ~/.permissions/templates)"}`,
			"warning",
		);
		return;
	}
	let policy: Policy;
	try {
		policy = await loadTemplate(name);
	} catch (e) {
		ctx.ui.notify(`load failed: ${(e as Error).message}`, "error");
		return;
	}
	const existed = sctx.removeTemplate(name);
	sctx.pushTemplate(policy);
	for (const r of policy.rules) sctx.addRuleToActive(r, name);
	ctx.ui.notify(
		`${existed ? "reloaded" : "loaded"} template ${name} (${policy.rules.length} rule${policy.rules.length === 1 ? "" : "s"})`,
		"info",
	);
}

export function handleUnload(
	args: string[],
	ctx: ExtensionContext,
	sctx: SliceContext,
): void {
	const name = args.join(" ").trim();
	if (!name) {
		ctx.ui.notify("usage: /permissions unload <name>", "warning");
		return;
	}
	const ok = sctx.removeTemplate(name);
	if (!ok) {
		ctx.ui.notify(`template "${name}" was not loaded`, "warning");
		return;
	}
	ctx.ui.notify(
		`unloaded ${name} (rules already pushed to proxy stay in effect for this session; restart to fully clear)`,
		"info",
	);
}

export function handleAudit(args: string[], ctx: ExtensionContext): void {
	let n = 20;
	let cwdOnly: string | undefined;
	let grep: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "-n" && args[i + 1]) {
			n = Number.parseInt(args[++i], 10);
		} else if (a === "--cwd-only") {
			cwdOnly = ctx.cwd;
		} else if (a === "--grep" && args[i + 1]) {
			grep = args[++i];
		}
	}
	const entries = readAudit({ last: n, cwdOnly, grep });
	if (entries.length === 0) {
		ctx.ui.notify("(no matching audit entries)", "info");
		return;
	}
	const lines = entries.map((e) => {
		const ts = e.ts.replace("T", " ").slice(0, 19);
		const dec = e.decision === "allow" ? `${C.green}allow${C.reset}` : `${C.red}deny${C.reset}`;
		const src = `${C.dim}${e.source}${C.reset}`;
		const ruleStr = e.rule ? ` ${C.dim}rule:${C.reset}${e.rule}` : "";
		const tplStr = e.template ? ` ${C.dim}tpl:${C.reset}${e.template}` : "";
		return `  ${C.dim}${ts}${C.reset}  ${dec} ${src} ${e.tool} ${e.action}${ruleStr}${tplStr}`;
	});
	ctx.ui.notify(
		`${C.bold}${C.cyan}audit${C.reset} (last ${entries.length}):\n${lines.join("\n")}`,
		"info",
	);
}
