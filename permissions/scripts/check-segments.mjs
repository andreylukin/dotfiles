// Empirically verify what tree-sitter-bash extracts as segments for dangerous
// inputs. Runs the parser and prints the segment list — never executes bash.
//
// Usage:
//   node permissions/scripts/check-segments.mjs
//
// Add your own cases via CLI args:
//   node permissions/scripts/check-segments.mjs 'echo $(date)' 'foo && bar'

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";
import { evaluateBash, parsePolicy } from "@permissions/shared";
import { readFileSync } from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_SRC = path.resolve(HERE, "../../pi/agent/extensions/permissions/src");
const BASH_WASM = path.join(EXT_SRC, "tree-sitter-bash.wasm");
const PY_WASM = path.join(EXT_SRC, "tree-sitter-python.wasm");

const TRIVIAL = parsePolicy(
	readFileSync(path.resolve(HERE, "../templates/bash-trivial.csp"), "utf8"),
);

const DANGEROUS_PY_CALLS = new Set([
	"os.system",
	"os.popen",
	"os.exec", "os.execv", "os.execvp", "os.execvpe", "os.execve", "os.execle", "os.execlp", "os.execlpe",
	"os.spawn", "os.spawnv", "os.spawnvp", "os.spawnvpe", "os.spawnve", "os.spawnle", "os.spawnlp", "os.spawnlpe",
	"subprocess.run", "subprocess.call", "subprocess.check_call", "subprocess.check_output", "subprocess.Popen",
	"subprocess.getoutput", "subprocess.getstatusoutput",
	"exec", "eval", "compile", "__import__",
]);

const DEFAULT_CASES = [
	// Subshells / command substitution
	"cat $(rm -rf /)",
	"echo `rm -rf /`",

	// Sequences and pipes
	"ls; rm -rf /",
	"ls && rm -rf /",
	"ls || rm -rf /",
	"true | rm -rf /",

	// Indirection — tree-sitter CAN'T see through these
	"eval $DANGER",
	"bash -c 'rm -rf /'",
	"sh -c 'rm -rf /'",
	"echo cm0gLXJmIC8= | base64 -d | sh",
	"python3 -c \"import os; os.system('rm -rf /')\"",
	"node -e \"require('child_process').exec('rm -rf /')\"",

	// Safe references for comparison
	"ls",
	"ls && pwd",
	"cat README.md",
];

await Parser.init();
const bashLang = await Language.load(BASH_WASM);
const pyLang = await Language.load(PY_WASM);
const bashParser = new Parser();
bashParser.setLanguage(bashLang);
const pyParser = new Parser();
pyParser.setLanguage(pyLang);

function literalString(node) {
	if (node.type === "word") return node.text;
	if (node.type === "string" || node.type === "raw_string") {
		const t = node.text;
		if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
			return t.slice(1, -1);
		}
	}
	return null;
}

function getInterpreterArg(node, matcher) {
	const name = node.childForFieldName("name")?.text;
	if (!name) return null;
	const matches = Array.isArray(matcher) ? matcher.includes(name) : matcher.test(name);
	if (!matches) return null;
	const args = [];
	for (let i = 0; i < node.namedChildCount; i++) {
		const c = node.namedChild(i);
		if (c && c.type !== "command_name") args.push(c);
	}
	for (let i = 0; i < args.length - 1; i++) {
		if (args[i].text === "-c") return literalString(args[i + 1]);
	}
	return null;
}

function extractPythonDangers(src) {
	const tree = pyParser.parse(src);
	const out = [];
	const visit = (n) => {
		if (n.type === "call") {
			const fn = n.childForFieldName("function");
			if (fn && DANGEROUS_PY_CALLS.has(fn.text)) out.push(n.text.trim());
		}
		for (let i = 0; i < n.namedChildCount; i++) {
			const c = n.namedChild(i);
			if (c) visit(c);
		}
	};
	visit(tree.rootNode);
	return out;
}

function extract(cmd, depth = 0, out = []) {
	if (depth > 4) {
		out.push({ text: cmd, kind: "shell", depth });
		return out;
	}
	const tree = bashParser.parse(cmd);
	const cmdNodes = [];
	const collect = (n) => {
		if (n.type === "command") cmdNodes.push(n);
		for (let i = 0; i < n.namedChildCount; i++) {
			const c = n.namedChild(i);
			if (c) collect(c);
		}
	};
	collect(tree.rootNode);
	for (const node of cmdNodes) {
		const text = node.text.trim();
		if (!text) continue;
		out.push({ text, kind: "shell", depth });
		const sh = getInterpreterArg(node, ["bash", "sh"]);
		if (sh !== null) {
			extract(sh, depth + 1, out);
			continue;
		}
		const py = getInterpreterArg(node, /^python[0-9.]*$/);
		if (py !== null) {
			for (const d of extractPythonDangers(py)) {
				out.push({ text: d, kind: "python", depth: depth + 1 });
			}
		}
	}
	if (out.length === 0 && depth === 0) out.push({ text: cmd.trim(), kind: "shell", depth });
	return out;
}

const cases = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_CASES;

for (const cmd of cases) {
	const segs = extract(cmd);
	const texts = segs.map((s) => s.text);
	const result = evaluateBash(texts, [TRIVIAL]);
	console.log(`\nINPUT: ${JSON.stringify(cmd)}`);
	console.log(`  segments (${segs.length}):`);
	for (const s of segs) {
		const indent = "  ".repeat(s.depth);
		const tag = s.kind === "python" ? "[py]" : s.depth > 0 ? "[sh]" : "    ";
		console.log(`    ${indent}${tag} ${JSON.stringify(s.text)}`);
	}
	console.log(
		`  vs bash-trivial: ${result.decision} — ${result.matchedRule?.pattern ?? result.reason}`,
	);
}
