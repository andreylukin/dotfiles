import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";
import { netAction } from "./policy.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.join(HERE, "tree-sitter-bash.wasm");

let parserPromise: Promise<Parser> | null = null;

async function getParser(): Promise<Parser> {
	if (!parserPromise) {
		parserPromise = (async () => {
			await Parser.init();
			const lang = await Language.load(WASM_PATH);
			const p = new Parser();
			p.setLanguage(lang);
			return p;
		})();
	}
	return parserPromise;
}

export interface ExtractedAction {
	action: string;
}

export interface ExtractResult {
	actions: ExtractedAction[];
}

/**
 * Per-binary set of script-from-string flags. Any command node whose binary
 * matches the key and whose args contain any of the flags is an inline script —
 * we auto-sandbox the invocation rather than refuse.
 */
const INLINE_INTERPRETER_FLAGS: {
	binary: RegExp;
	flags: Set<string>;
	language: "python" | "node" | "bash";
	label: string;
}[] = [
	{ binary: /^(python|python2|python3|python3\.\d+)$/, flags: new Set(["-c"]), language: "python", label: "python -c" },
	{ binary: /^(node|nodejs)$/, flags: new Set(["-e", "--eval", "-p", "--print"]), language: "node", label: "node -e" },
	{ binary: /^(bash|sh|zsh|ksh|dash)$/, flags: new Set(["-c"]), language: "bash", label: "shell -c" },
];

/**
 * Bare binaries that take their script as the next positional arg with no
 * explicit flag — there's no source body to sandbox separately, so we still
 * refuse these.
 */
const REFUSE_BARE_BINARIES: { match: RegExp; label: string }[] = [
	{ match: /^eval$/, label: "eval" },
	{ match: /^source$/, label: "source" },
	{ match: /^\.$/, label: "." },
];

export interface InlineScript {
	startIndex: number;
	endIndex: number;
	originalText: string;
	language: "python" | "node" | "bash";
	label: string;
	flag: string;
	source: string;
}

async function parseTree(command: string): Promise<import("web-tree-sitter").Tree | null> {
	try {
		const p = await getParser();
		return p.parse(command);
	} catch {
		return null;
	}
}

function collectCommandNodes(tree: import("web-tree-sitter").Tree): import("web-tree-sitter").Node[] {
	const out: import("web-tree-sitter").Node[] = [];
	const walk = (node: import("web-tree-sitter").Node): void => {
		if (node.type === "command") out.push(node);
		for (let i = 0; i < node.namedChildCount; i++) {
			const c = node.namedChild(i);
			if (c) walk(c);
		}
	};
	walk(tree.rootNode);
	return out;
}

/**
 * Refuse only bare `eval` / `source` / `.` — there's no isolable source body
 * to sandbox for those shapes. Inline interpreter calls (`python -c`, etc.)
 * are handled by `findInlineScripts` and auto-sandboxed instead.
 */
export async function findRefusedShape(command: string): Promise<string | null> {
	const tree = await parseTree(command);
	if (!tree) return null;
	for (const node of collectCommandNodes(tree)) {
		const name = node.childForFieldName("name")?.text;
		if (!name) continue;
		for (const bare of REFUSE_BARE_BINARIES) {
			if (bare.match.test(name)) return bare.label;
		}
	}
	return null;
}

/**
 * Walk the bash AST and collect every inline-interpreter invocation (e.g.
 * `python3 -c "..."`, `node -e "..."`). Each result carries the byte range of
 * the command node so the caller can splice in `sandbox-exec -f <profile>`
 * before execution. Covers shapes inside pipes, `&&`/`||`, `;`, `$(...)`, etc.
 */
export async function findInlineScripts(command: string): Promise<InlineScript[]> {
	const tree = await parseTree(command);
	if (!tree) return [];
	const out: InlineScript[] = [];
	for (const node of collectCommandNodes(tree)) {
		const nameNode = node.childForFieldName("name");
		const name = nameNode?.text;
		if (!name) continue;

		const argNodes: import("web-tree-sitter").Node[] = [];
		for (let i = 0; i < node.namedChildCount; i++) {
			const c = node.namedChild(i);
			if (c && c.type !== "command_name") argNodes.push(c);
		}
		for (const rule of INLINE_INTERPRETER_FLAGS) {
			if (!rule.binary.test(name)) continue;
			for (let j = 0; j < argNodes.length; j++) {
				const flagText = argNodes[j].text;
				if (!rule.flags.has(flagText)) continue;
				const srcNode = argNodes[j + 1];
				if (!srcNode) continue;
				const source = literalString(srcNode);
				if (source === null) continue;
				out.push({
					startIndex: node.startIndex,
					endIndex: node.endIndex,
					originalText: node.text,
					language: rule.language,
					label: rule.label,
					flag: flagText,
					source,
				});
				break;
			}
		}
	}
	return out;
}

export async function extractActions(command: string): Promise<ExtractResult> {
	const p = await getParser();
	const tree = p.parse(command);
	if (!tree) return { actions: [] };

	const actions: ExtractedAction[] = [];
	const visit = (node: import("web-tree-sitter").Node): void => {
		if (node.type === "command") {
			const a = handleCommand(node);
			if (a) actions.push(a);
		}
		for (let i = 0; i < node.namedChildCount; i++) {
			const child = node.namedChild(i);
			if (child) visit(child);
		}
	};
	visit(tree.rootNode);
	return { actions };
}

function handleCommand(node: import("web-tree-sitter").Node): ExtractedAction | null {
	const nameNode = node.childForFieldName("name");
	const name = nameNode?.text;
	if (!name) return null;

	const args: import("web-tree-sitter").Node[] = [];
	for (let i = 0; i < node.namedChildCount; i++) {
		const child = node.namedChild(i);
		if (!child) continue;
		if (child.type === "command_name") continue;
		args.push(child);
	}

	if (name === "curl") return parseCurl(args);
	if (name === "wget") return parseWget(args);
	if (name === "git") return parseGit(args);
	return null;
}

function parseCurl(args: import("web-tree-sitter").Node[]): ExtractedAction | null {
	let method = "GET";
	let url: string | null = null;
	let hasData = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const text = arg.text;
		if (text === "-X" || text === "--request") {
			const next = args[i + 1];
			const m = next ? literalString(next) : null;
			if (m) method = m.toUpperCase();
			i++;
			continue;
		}
		if (text === "-d" || text === "--data" || text === "--data-raw" || text === "--data-binary") {
			hasData = true;
			i++;
			continue;
		}
		const lit = literalString(arg);
		if (lit && looksLikeUrl(lit) && url === null) url = lit;
	}
	if (!url) return null;
	if (hasData && method === "GET") method = "POST";
	const action = urlToAction(method, url);
	return action ? { action } : null;
}

function parseWget(args: import("web-tree-sitter").Node[]): ExtractedAction | null {
	let method = "GET";
	let url: string | null = null;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const text = arg.text;
		if (text === "--method") {
			const next = args[i + 1];
			const m = next ? literalString(next) : null;
			if (m) method = m.toUpperCase();
			i++;
			continue;
		}
		const eqMatch = text.match(/^--method=(.+)$/);
		if (eqMatch) {
			method = eqMatch[1].toUpperCase();
			continue;
		}
		const lit = literalString(arg);
		if (lit && looksLikeUrl(lit) && url === null) url = lit;
	}
	if (!url) return null;
	const action = urlToAction(method, url);
	return action ? { action } : null;
}

function parseGit(args: import("web-tree-sitter").Node[]): ExtractedAction | null {
	const sub = args[0] ? literalString(args[0]) : null;
	if (!sub) return null;
	const writes = new Set(["clone", "fetch", "pull", "push"]);
	if (!writes.has(sub)) return null;
	for (let i = 1; i < args.length; i++) {
		const lit = literalString(args[i]);
		if (lit && (lit.includes("://") || lit.startsWith("git@"))) {
			const action = urlToAction("GET", lit);
			return action ? { action } : null;
		}
	}
	return null;
}

function literalString(node: import("web-tree-sitter").Node): string | null {
	if (node.type === "word") return node.text;
	if (node.type === "string" || node.type === "raw_string") {
		for (let i = 0; i < node.namedChildCount; i++) {
			const c = node.namedChild(i);
			if (!c) continue;
			if (c.type === "string_content") continue;
			return null; // contains expansion
		}
		const t = node.text;
		if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
			return t.slice(1, -1);
		}
		return t;
	}
	return null;
}

function looksLikeUrl(s: string): boolean {
	return /^https?:\/\//i.test(s) || /^git@/.test(s);
}

function urlToAction(method: string, raw: string): string | null {
	try {
		if (raw.startsWith("git@")) {
			const m = raw.match(/^git@([^:]+):/);
			if (!m) return null;
			return netAction(method, m[1], "/");
		}
		const url = new URL(raw);
		return netAction(method, url.hostname, url.pathname + url.search);
	} catch {
		return null;
	}
}
