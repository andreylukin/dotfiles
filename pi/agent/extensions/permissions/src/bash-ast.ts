import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";
import { netAction } from "./policy.js";
import { extractPythonDangers } from "./python-ast.js";

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

export interface Segment {
	text: string;
	kind: "shell" | "python";
	depth: number;
	/** For shell segments wrapping `python -c '<src>'`: byte offsets of <src> within `text`. Used to splice highlighted python into the displayed segment. */
	pythonBodyRange?: { start: number; end: number };
}

const MAX_DEPTH = 4;

export async function extractSegments(command: string): Promise<Segment[]> {
	const trimmed = command.trim();
	if (!trimmed) return [];
	const out: Segment[] = [];
	await extractSegmentsRec(trimmed, 0, out);
	if (out.length === 0) out.push({ text: trimmed, kind: "shell", depth: 0 });
	return out;
}

async function extractSegmentsRec(command: string, depth: number, out: Segment[]): Promise<void> {
	if (depth > MAX_DEPTH) {
		out.push({ text: command, kind: "shell", depth });
		return;
	}
	let tree: import("web-tree-sitter").Tree | null = null;
	try {
		const p = await getParser();
		tree = p.parse(command);
	} catch {
		out.push({ text: command, kind: "shell", depth });
		return;
	}
	if (!tree) {
		out.push({ text: command, kind: "shell", depth });
		return;
	}

	const commandNodes: import("web-tree-sitter").Node[] = [];
	const collect = (node: import("web-tree-sitter").Node): void => {
		if (node.type === "command") commandNodes.push(node);
		for (let i = 0; i < node.namedChildCount; i++) {
			const child = node.namedChild(i);
			if (child) collect(child);
		}
	};
	collect(tree.rootNode);

	for (const node of commandNodes) {
		const rawText = node.text;
		const trimmed = rawText.trim();
		if (!trimmed) continue;
		const leading = rawText.length - rawText.trimStart().length;

		const shellInner = getInterpreterArg(node, ["bash", "sh"]);
		if (shellInner !== null) {
			out.push({ text: trimmed, kind: "shell", depth });
			await extractSegmentsRec(shellInner.src, depth + 1, out);
			continue;
		}
		const pythonInner = getInterpreterArg(node, /^python[0-9.]*$/);
		if (pythonInner !== null) {
			out.push({
				text: trimmed,
				kind: "shell",
				depth,
				pythonBodyRange: {
					start: pythonInner.bodyRange.start - leading,
					end: pythonInner.bodyRange.end - leading,
				},
			});
			const dangers = await extractPythonDangers(pythonInner.src);
			for (const d of dangers) {
				out.push({ text: d, kind: "python", depth: depth + 1 });
			}
			continue;
		}
		out.push({ text: trimmed, kind: "shell", depth });
	}
}

interface InterpreterArg {
	src: string;
	/** Byte offsets of the literal string content within the outer command's text. */
	bodyRange: { start: number; end: number };
}

function getInterpreterArg(
	node: import("web-tree-sitter").Node,
	matcher: string[] | RegExp,
): InterpreterArg | null {
	const name = node.childForFieldName("name")?.text;
	if (!name) return null;
	const matches = Array.isArray(matcher) ? matcher.includes(name) : matcher.test(name);
	if (!matches) return null;

	const args: import("web-tree-sitter").Node[] = [];
	for (let i = 0; i < node.namedChildCount; i++) {
		const c = node.namedChild(i);
		if (c && c.type !== "command_name") args.push(c);
	}
	for (let i = 0; i < args.length - 1; i++) {
		if (args[i].text === "-c") {
			const argNode = args[i + 1];
			const src = literalString(argNode);
			if (src === null) return null;
			let absStart = argNode.startIndex;
			let absEnd = argNode.endIndex;
			if (argNode.type === "string" || argNode.type === "raw_string") {
				absStart += 1; // skip opening quote
				absEnd -= 1; // skip closing quote
			}
			return {
				src,
				bodyRange: {
					start: absStart - node.startIndex,
					end: absEnd - node.startIndex,
				},
			};
		}
	}
	return null;
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
