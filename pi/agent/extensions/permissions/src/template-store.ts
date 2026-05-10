import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Policy, Rule } from "@permissions/shared";

const USER_DIR = path.join(os.homedir(), ".permissions", "templates");

function templatePath(name: string): string {
	return path.join(USER_DIR, `${name}.csp`);
}

async function ensureDir(): Promise<void> {
	await fs.mkdir(USER_DIR, { recursive: true });
}

export async function listUserTemplates(): Promise<string[]> {
	try {
		const files = await fs.readdir(USER_DIR);
		return files.filter((f) => f.endsWith(".csp")).map((f) => f.replace(/\.csp$/, "")).sort();
	} catch {
		return [];
	}
}

/**
 * List bundled template names. The CLI passes the dir via env at launch.
 * Returns [] if the env var is missing or the dir can't be read.
 */
export async function listBundledTemplates(): Promise<string[]> {
	const dir = process.env.PI_PERMISSIONS_BUNDLED_TEMPLATES_DIR;
	if (!dir) return [];
	try {
		const files = await fs.readdir(dir);
		return files.filter((f) => f.endsWith(".csp")).map((f) => f.replace(/\.csp$/, "")).sort();
	} catch {
		return [];
	}
}

/** Combined list of names with origin (user override wins on collision). */
export async function listAllTemplates(): Promise<{ name: string; origin: "user" | "bundled" }[]> {
	const user = await listUserTemplates();
	const bundled = await listBundledTemplates();
	const userSet = new Set(user);
	const out: { name: string; origin: "user" | "bundled" }[] = [];
	for (const n of user) out.push({ name: n, origin: "user" });
	for (const n of bundled) if (!userSet.has(n)) out.push({ name: n, origin: "bundled" });
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function templateExists(name: string): Promise<boolean> {
	try {
		await fs.access(templatePath(name));
		return true;
	} catch {
		return false;
	}
}

function ruleToLine(r: Rule): string {
	return `${r.effect} (action == "${r.pattern}");`;
}

/** Append rules to an existing user template, creating it if absent. */
export async function appendRulesToTemplate(name: string, rules: Rule[]): Promise<string> {
	await ensureDir();
	const p = templatePath(name);
	const exists = await templateExists(name);
	const header = exists ? "" : `@name("${name}")\n`;
	const body = rules.map(ruleToLine).join("\n");
	const sep = exists ? "\n" : "";
	await fs.appendFile(p, `${header}${sep}${body}\n`);
	return p;
}

/** Write a brand new template file. Errors if it already exists. */
export async function writeNewTemplate(name: string, rules: Rule[]): Promise<string> {
	await ensureDir();
	const p = templatePath(name);
	if (await templateExists(name)) {
		throw new Error(`template "${name}" already exists at ${p}`);
	}
	const lines = [`@name("${name}")`, ...rules.map(ruleToLine)];
	await fs.writeFile(p, `${lines.join("\n")}\n`);
	return p;
}

/** Load a user or bundled template into a Policy struct. */
export async function loadTemplate(name: string): Promise<Policy> {
	const candidates = [templatePath(name)];
	const bundleDir = process.env.PI_PERMISSIONS_BUNDLED_TEMPLATES_DIR;
	if (bundleDir) candidates.push(path.join(bundleDir, `${name}.csp`));
	let raw: string | null = null;
	for (const p of candidates) {
		try {
			raw = await fs.readFile(p, "utf8");
			break;
		} catch {
			// try next
		}
	}
	if (raw === null) {
		throw new Error(`template "${name}" not found in user or bundled dirs`);
	}
	return parseTemplate(name, raw);
}

/** Minimal parser for the .csp shape we read/write. */
function parseTemplate(fallbackName: string, src: string): Policy {
	const rules: Rule[] = [];
	let name = fallbackName;
	for (const rawLine of src.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		if (line.startsWith("//") || line.startsWith("#")) continue;
		const nameMatch = line.match(/^@name\(\s*"([^"]+)"\s*\)/);
		if (nameMatch) {
			name = nameMatch[1];
			continue;
		}
		const m = line.match(/^(permit|forbid)\s*\(\s*action\s*==\s*"([^"]+)"\s*\)\s*;?$/);
		if (m) rules.push({ effect: m[1] as "permit" | "forbid", pattern: m[2] });
	}
	return { name, rules };
}
