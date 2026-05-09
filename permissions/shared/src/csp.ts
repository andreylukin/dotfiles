import type { Action } from "./action.js";

export type Effect = "permit" | "forbid";
export type Decision = "allow" | "deny";

export interface Rule {
	effect: Effect;
	pattern: string;
}

export interface Policy {
	name?: string;
	rules: Rule[];
}

export interface DecisionResult {
	decision: Decision;
	matchedRule?: Rule;
	matchedPolicy?: string;
	reason: string;
}

const NAME_RE = /^@name\("([^"]+)"\)$/;
const RULE_RE = /^(permit|forbid)\s*\(\s*action\s*==\s*"([^"]+)"\s*\)\s*;$/;

export function parsePolicy(source: string): Policy {
	const rules: Rule[] = [];
	let name: string | undefined;

	const lines = source.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line === "" || line.startsWith("#") || line.startsWith("//")) continue;

		const nameMatch = NAME_RE.exec(line);
		if (nameMatch) {
			name = nameMatch[1];
			continue;
		}

		const ruleMatch = RULE_RE.exec(line);
		if (ruleMatch) {
			rules.push({ effect: ruleMatch[1] as Effect, pattern: ruleMatch[2] });
			continue;
		}

		throw new Error(`csp parse error at line ${i + 1}: ${line}`);
	}

	return { name, rules };
}

export function matches(pattern: string, action: Action): boolean {
	const DOUBLE = "\x00";
	const escaped = pattern
		.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, DOUBLE)
		.replace(/\*/g, "[^/:]*")
		.replace(new RegExp(DOUBLE, "g"), ".*");
	return new RegExp(`^${escaped}$`).test(action);
}

export function evaluate(action: Action, policies: Policy[]): DecisionResult {
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
