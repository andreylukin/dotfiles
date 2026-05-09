export interface LintResult {
	ok: boolean;
	reason?: string;
}

// Tree-sitter splits bash on `;`, `&&`, `||`, `|`, `$(...)`, backticks — so a
// segment never contains those. But a segment DOES contain `>`, `<`, `>>`,
// `<<`, glob `*`, `?`, `$VAR`, quotes, and arbitrary args. The linter rejects
// regexes that allow any of these in unbounded production positions.
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
