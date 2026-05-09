import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.join(HERE, "tree-sitter-python.wasm");

let parserPromise: Promise<Parser> | null = null;

export async function getPythonParser(): Promise<Parser> {
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

export const DANGEROUS_PY_CALLS = new Set([
	"os.system",
	"os.popen",
	"os.exec",
	"os.execv",
	"os.execvp",
	"os.execvpe",
	"os.execve",
	"os.execle",
	"os.execlp",
	"os.execlpe",
	"os.spawn",
	"os.spawnv",
	"os.spawnvp",
	"os.spawnvpe",
	"os.spawnve",
	"os.spawnle",
	"os.spawnlp",
	"os.spawnlpe",
	"subprocess.run",
	"subprocess.call",
	"subprocess.check_call",
	"subprocess.check_output",
	"subprocess.Popen",
	"subprocess.getoutput",
	"subprocess.getstatusoutput",
	"exec",
	"eval",
	"compile",
	"__import__",
]);

export async function extractPythonDangers(src: string): Promise<string[]> {
	let tree: import("web-tree-sitter").Tree | null = null;
	try {
		const p = await getPythonParser();
		tree = p.parse(src);
	} catch {
		return [];
	}
	if (!tree) return [];

	const dangers: string[] = [];
	const visit = (n: import("web-tree-sitter").Node): void => {
		if (n.type === "call") {
			const fn = n.childForFieldName("function");
			if (fn && DANGEROUS_PY_CALLS.has(fn.text)) {
				dangers.push(n.text.trim());
			}
		}
		for (let i = 0; i < n.namedChildCount; i++) {
			const c = n.namedChild(i);
			if (c) visit(c);
		}
	};
	visit(tree.rootNode);
	return dangers;
}
