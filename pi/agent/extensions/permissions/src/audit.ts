import { appendFileSync, mkdirSync, readFileSync, existsSync, statSync, renameSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const AUDIT_DIR = path.join(os.homedir(), ".permissions");
const AUDIT_FILE = path.join(AUDIT_DIR, "audit.jsonl");
const ROTATE_BYTES = 10 * 1024 * 1024;

export type AuditDecision = "allow" | "deny";
export type AuditSource =
	| "existing"
	| "added"
	| "once-allow"
	| "once-deny"
	| "denied"
	| "default-deny";

export interface AuditEntry {
	ts: string;
	cwd: string;
	tool: string;
	action: string;
	decision: AuditDecision;
	source: AuditSource;
	rule: string | null;
	template: string | null;
	toolCallId?: string;
}

let dirEnsured = false;

function ensureDir(): void {
	if (dirEnsured) return;
	mkdirSync(AUDIT_DIR, { recursive: true });
	dirEnsured = true;
}

function maybeRotate(): void {
	try {
		if (!existsSync(AUDIT_FILE)) return;
		if (statSync(AUDIT_FILE).size < ROTATE_BYTES) return;
		renameSync(AUDIT_FILE, `${AUDIT_FILE}.1`);
	} catch {
		// best effort
	}
}

export function appendAudit(entry: Omit<AuditEntry, "ts" | "cwd"> & { cwd?: string }): void {
	try {
		ensureDir();
		maybeRotate();
		const full: AuditEntry = {
			ts: new Date().toISOString(),
			cwd: entry.cwd ?? process.cwd(),
			...entry,
		};
		appendFileSync(AUDIT_FILE, `${JSON.stringify(full)}\n`);
	} catch {
		// audit must never break the user flow
	}
}

export interface ReadAuditOpts {
	last?: number;
	grep?: string;
	cwdOnly?: string;
	rotated?: boolean;
}

export function readAudit(opts: ReadAuditOpts = {}): AuditEntry[] {
	const out: AuditEntry[] = [];
	const files = opts.rotated && existsSync(`${AUDIT_FILE}.1`) ? [`${AUDIT_FILE}.1`, AUDIT_FILE] : [AUDIT_FILE];
	for (const f of files) {
		if (!existsSync(f)) continue;
		const raw = readFileSync(f, "utf8");
		for (const line of raw.split("\n")) {
			if (!line) continue;
			try {
				const entry = JSON.parse(line) as AuditEntry;
				if (opts.cwdOnly && entry.cwd !== opts.cwdOnly) continue;
				if (opts.grep && !JSON.stringify(entry).includes(opts.grep)) continue;
				out.push(entry);
			} catch {
				// skip malformed
			}
		}
	}
	const last = opts.last ?? out.length;
	return out.slice(-last);
}

/**
 * Count how many recent audit entries (within `lookback` lines) match each
 * rule pattern. Used by the curate UI to show usage hits per rule.
 */
export function countHitsByRule(rules: { pattern: string }[], lookback = 1000): Map<string, number> {
	const entries = readAudit({ last: lookback });
	const counts = new Map<string, number>();
	for (const r of rules) counts.set(r.pattern, 0);
	for (const e of entries) {
		if (!e.rule) continue;
		const c = counts.get(e.rule);
		if (c !== undefined) counts.set(e.rule, c + 1);
	}
	return counts;
}
