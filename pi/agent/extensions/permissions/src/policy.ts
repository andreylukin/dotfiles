// Vendored runtime copy of the policy engine. The extension is loaded by pi
// from a symlinked path; pi/jiti's module resolver can't walk back to
// dotfiles' node_modules to find @permissions/shared at runtime. Type imports
// from @permissions/shared still work (TS erases them); only runtime values
// need to live here.

import { globToRegex } from "./net-model.js";
import type { Rule, Policy, DecisionResult } from "@permissions/shared";

export function netAction(method: string, host: string, pathAndQuery: string): string {
	return `net:${method}:${host}${pathAndQuery}`;
}

export function bashAction(regex: string): string {
	return `bash:${regex}`;
}

export function evaluate(action: string, policies: Policy[]): DecisionResult {
	let permit: { rule: Rule; policy?: string } | undefined;

	for (const policy of policies) {
		for (const rule of policy.rules) {
			if (rule.pattern.startsWith("bash:")) continue;
			if (!matches(rule.pattern, action)) continue;
			if (rule.effect === "forbid") {
				return {
					decision: "deny",
					matchedRule: rule,
					matchedPolicy: policy.name,
					reason: `forbid "${rule.pattern}"${policy.name ? ` (${policy.name})` : ""}`,
				};
			}
			if (!permit) permit = { rule, policy: policy.name };
		}
	}

	if (permit) {
		return {
			decision: "allow",
			matchedRule: permit.rule,
			matchedPolicy: permit.policy,
			reason: `permit "${permit.rule.pattern}"${permit.policy ? ` (${permit.policy})` : ""}`,
		};
	}

	return { decision: "deny", reason: "default deny" };
}

function compileBashRule(pattern: string): RegExp | null {
	if (!pattern.startsWith("bash:")) return null;
	try {
		return new RegExp(`^(?:${pattern.slice("bash:".length)})$`);
	} catch {
		return null;
	}
}

export function evaluateBash(segments: string[], policies: Policy[]): DecisionResult {
	if (segments.length === 0) return { decision: "deny", reason: "no segments" };

	for (const policy of policies) {
		for (const rule of policy.rules) {
			if (rule.effect !== "forbid") continue;
			const re = compileBashRule(rule.pattern);
			if (!re) continue;
			for (const seg of segments) {
				if (re.test(seg)) {
					return {
						decision: "deny",
						matchedRule: rule,
						matchedPolicy: policy.name,
						reason: `forbid "${rule.pattern}" matches "${seg}"${policy.name ? ` (${policy.name})` : ""}`,
					};
				}
			}
		}
	}

	const segmentMatches: Array<{ rule: Rule; policyName?: string } | undefined> = segments.map(
		(seg) => {
			for (const policy of policies) {
				for (const rule of policy.rules) {
					if (rule.effect !== "permit") continue;
					const re = compileBashRule(rule.pattern);
					if (!re) continue;
					if (re.test(seg)) return { rule, policyName: policy.name };
				}
			}
			return undefined;
		},
	);

	if (segmentMatches.every((m) => m !== undefined)) {
		const first = segmentMatches[0]!;
		const uniquePatterns = new Set(segmentMatches.map((m) => m!.rule.pattern));
		const reason =
			uniquePatterns.size === 1
				? `permit "${first.rule.pattern}"${first.policyName ? ` (${first.policyName})` : ""}`
				: `permit (${uniquePatterns.size} rules cover ${segments.length} segments)`;
		return {
			decision: "allow",
			matchedRule: first.rule,
			matchedPolicy: first.policyName,
			reason,
		};
	}

	return { decision: "deny", reason: "default deny" };
}

export function regexCoversSegments(regex: string, segments: string[]): boolean {
	let re: RegExp;
	try {
		re = new RegExp(`^(?:${regex})$`);
	} catch {
		return false;
	}
	return segments.length > 0 && segments.every((s) => re.test(s));
}

// Vendored from @permissions/shared (regex-lint.ts). Tree-sitter splits bash on
// `;`, `&&`, `||`, `|`, `$(...)`, backticks — segments never contain those. But
// segments DO contain `>`, `<`, `>>`, `<<`, glob `*`, `?`, `$VAR`, quotes, and
// arbitrary args. Reject regexes that allow any of these in unbounded position.
export interface LintResult {
	ok: boolean;
	reason?: string;
}

const SHELL_METAS = [">", "<", "*", "`", "$"];

export function lintBashRegex(regex: string): LintResult {
	if (regex.length === 0) {
		return { ok: false, reason: "regex is empty" };
	}

	try {
		new RegExp(`^(?:${regex})$`);
	} catch (e) {
		return { ok: false, reason: `regex does not compile: ${(e as Error).message}` };
	}

	if (/(?<!\\)\.[*+]/.test(regex)) {
		return {
			ok: false,
			reason:
				"uses `.*` or `.+` — `.` matches shell metacharacters like `>`, `*`, backtick. " +
				"Use a specific char class such as `[\\w./-]+` instead.",
		};
	}

	if (/\\[SW][*+]/.test(regex)) {
		return {
			ok: false,
			reason:
				"uses `\\S+/\\S*` or `\\W+/\\W*` — these match shell metacharacters like `>`, `*`. " +
				"Use a specific char class such as `[\\w./-]+` instead.",
		};
	}

	const dotBraceMatch = /(?<!\\)(?<!\[[^\]]{0,40})\.\{\d+(?:,\d*)?\}/.exec(regex);
	if (dotBraceMatch) {
		return {
			ok: false,
			reason:
				`uses bounded \`${dotBraceMatch[0]}\` — ` +
				"`.` matches any char including shell metas. Use a specific char class.",
		};
	}

	const trailingCharClass = /\[(\^?(?:\\.|[^\]\\])*)\][*+]\$?$/.exec(regex);
	if (trailingCharClass) {
		const classSrc = `[${trailingCharClass[1]}]`;
		let probe: RegExp;
		try {
			probe = new RegExp(classSrc);
		} catch {
			return { ok: true };
		}
		for (const ch of SHELL_METAS) {
			if (probe.test(ch)) {
				return {
					ok: false,
					reason:
						`trailing char class \`${classSrc}\` with unbounded quantifier matches shell metachar \`${ch}\`. ` +
						"Tighten it (e.g., `[\\w./-]+`) or anchor it with a literal terminator.",
				};
			}
		}
	}

	return { ok: true };
}

/** True if expanding the glob (* = single segment, ** = anything) matches the action. */
export function globCovers(glob: string, action: string): boolean {
	const re = globToRegex(glob);
	if (!re) return false;
	return re.test(action);
}

/**
 * Lint a net glob produced by the local model. Catches the security-load-bearing
 * mistakes the prompt warns about: host wildcarding, missing prefix, malformed shape.
 * Method wildcarding (`*`) is allowed — that's the existing default for generalizeNet.
 */
export function lintNetGlob(glob: string, action: string): LintResult {
	if (!glob.startsWith("net:")) {
		return { ok: false, reason: `glob must start with "net:" (got ${JSON.stringify(glob)})` };
	}
	const globHost = extractHost(glob);
	const actionHost = extractHost(action);
	if (globHost === null) {
		return { ok: false, reason: `glob shape unexpected: ${JSON.stringify(glob)}` };
	}
	if (actionHost === null) {
		return { ok: false, reason: `action shape unexpected: ${JSON.stringify(action)}` };
	}
	if (globHost !== actionHost) {
		return {
			ok: false,
			reason:
				`host wildcarded or modified: glob host ${JSON.stringify(globHost)} != ` +
				`action host ${JSON.stringify(actionHost)}. Wildcarding the host would auto-approve ` +
				`other hosts — that is a security regression.`,
		};
	}
	return { ok: true };
}

function extractHost(s: string): string | null {
	// net:METHOD:host/path — host is between the second ':' and the first '/'
	const parts = s.split(":");
	if (parts.length < 3) return null;
	const rest = parts.slice(2).join(":");
	const slashIdx = rest.indexOf("/");
	return slashIdx === -1 ? rest : rest.slice(0, slashIdx);
}

function matches(pattern: string, action: string): boolean {
	const DOUBLE = "\x00";
	const escaped = pattern
		.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, DOUBLE)
		.replace(/\*/g, "[^/:]*")
		.replace(new RegExp(DOUBLE, "g"), ".*");
	return new RegExp(`^${escaped}$`).test(action);
}
