import { DANGEROUS_PY_CALLS, getPythonParser } from "./python-ast.js";

const C = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	cyan: "\x1b[36m",
	magenta: "\x1b[35m",
};

const PY_KEYWORDS = new Set([
	"import",
	"from",
	"as",
	"def",
	"class",
	"if",
	"elif",
	"else",
	"for",
	"while",
	"in",
	"return",
	"yield",
	"try",
	"except",
	"finally",
	"raise",
	"with",
	"lambda",
	"pass",
	"break",
	"continue",
	"global",
	"nonlocal",
	"and",
	"or",
	"not",
	"is",
	"True",
	"False",
	"None",
	"assert",
	"del",
	"async",
	"await",
]);

interface Range {
	start: number;
	end: number;
	color: string;
}

export async function highlightPython(src: string): Promise<string> {
	let tree: import("web-tree-sitter").Tree | null = null;
	try {
		const p = await getPythonParser();
		tree = p.parse(src);
	} catch {
		return src;
	}
	if (!tree) return src;

	const ranges: Range[] = [];

	const visit = (n: import("web-tree-sitter").Node): void => {
		if (n.type === "comment") {
			ranges.push({ start: n.startIndex, end: n.endIndex, color: C.dim });
			return;
		}
		if (n.type === "string" || n.type === "concatenated_string") {
			ranges.push({ start: n.startIndex, end: n.endIndex, color: C.green });
			return;
		}
		if (n.type === "integer" || n.type === "float") {
			ranges.push({ start: n.startIndex, end: n.endIndex, color: C.yellow });
			return;
		}
		if (!n.isNamed && PY_KEYWORDS.has(n.type)) {
			ranges.push({ start: n.startIndex, end: n.endIndex, color: C.magenta });
			return;
		}
		if (n.type === "call") {
			const fn = n.childForFieldName("function");
			if (fn) {
				const isDanger = DANGEROUS_PY_CALLS.has(fn.text);
				ranges.push({
					start: fn.startIndex,
					end: fn.endIndex,
					color: isDanger ? C.bold + C.red : C.cyan,
				});
			}
			for (let i = 0; i < n.namedChildCount; i++) {
				const c = n.namedChild(i);
				if (c && c !== fn) visit(c);
			}
			return;
		}
		for (let i = 0; i < n.childCount; i++) {
			const c = n.child(i);
			if (c) visit(c);
		}
	};
	visit(tree.rootNode);

	ranges.sort((a, b) => a.start - b.start || b.end - a.end);
	const filtered: Range[] = [];
	let lastEnd = -1;
	for (const r of ranges) {
		if (r.start >= lastEnd && r.end > r.start) {
			filtered.push(r);
			lastEnd = r.end;
		}
	}

	let out = "";
	let pos = 0;
	for (const r of filtered) {
		out += src.slice(pos, r.start);
		out += r.color + src.slice(r.start, r.end) + C.reset;
		pos = r.end;
	}
	out += src.slice(pos);
	return out;
}
