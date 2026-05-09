import { test } from "node:test";
import assert from "node:assert/strict";
import { lintBashRegex } from "./regex-lint.js";

// Each row: [name, regex, expected reason substring (loose keyword match)]
const REJECT: Array<[name: string, regex: string, reasonPattern: RegExp]> = [
	// --- Bare wildcards ---
	["bare .*", ".*", /shell metacharacters/],
	["anchored .*", "^.*$", /shell metacharacters/],
	["anchored .+", "^.+$", /shell metacharacters/],

	// --- Trailing free-form after command name (the `echo *` injection class) ---
	["trailing .* on echo (no space)", "^echo.*$", /shell metacharacters/],
	["trailing .* on echo (with space)", "^echo .*$", /shell metacharacters/],
	["trailing .+ on cat", "^cat .+$", /shell metacharacters/],
	["restish + .* (real LLM output)", "^restish .*$", /shell metacharacters/],
	["head + .*", "^head.*$", /shell metacharacters/],

	// --- The user's actual reported case ---
	[
		"per-alternative trailing .* (USER CASE)",
		"^(echo.*|restish.*|head.*)$",
		/shell metacharacters/,
	],
	["alternation each trailing", "^(ls.*|pwd.*|whoami.*)$", /shell metacharacters/],

	// --- \S / \W "not whitespace/word" wildcards ---
	["\\S+ unbounded", "^cat \\S+$", /shell metacharacters/],
	["\\S* unbounded", "^cat \\S*$", /shell metacharacters/],
	["\\W+ unbounded", "^echo \\W+$", /shell metacharacters/],

	// --- Bounded but using `.` ---
	["large bounded wildcard .{0,500}", "^cat .{0,500}$", /bounded/],
	["unbounded .{1,}", "^cat .{1,}$", /bounded/],
	["small bounded wildcard still rejected", "^cat .{0,40}$", /bounded/],

	// --- Trailing negated char class (allows shell metas) ---
	["trailing [^/]+ allows >, *", "^cat [^/]+$", /trailing char class/],
	[
		"trailing [^']+ at end (no closing quote in pattern)",
		"^echo [^']+$",
		/trailing char class/,
	],

	// --- Trailing positive char class that includes shell metas ---
	["trailing [\\s\\S]+", "^cat [\\s\\S]+$", /trailing char class/],
	["trailing [ -~]+ (full printable)", "^cat [ -~]+$", /trailing char class/],

	// --- Sanity ---
	["empty regex", "", /empty/],
	["non-compiling regex", "[unclosed", /does not compile/],
];

const ACCEPT: Array<[name: string, regex: string]> = [
	// Fixed commands
	["^pwd$", "^pwd$"],
	["^ls$", "^ls$"],
	["^true$", "^true$"],

	// Literal echo
	["^echo 'hello'$", "^echo 'hello'$"],
	["^echo \"hello world\"$", "^echo \"hello world\"$"],

	// Bounded subcommand
	["^git \\w+$", "^git \\w+$"],
	["^git (status|log|diff|fetch)$", "^git (status|log|diff|fetch)$"],

	// Specific char classes (no shell metas in the class)
	["^cat [\\w./_-]+$", "^cat [\\w./_-]+$"],
	["^cat [a-zA-Z0-9./_-]+\\.txt$", "^cat [a-zA-Z0-9./_-]+\\.txt$"],
	["^head -\\d+$", "^head -\\d+$"],
	["^head -n \\d+ [\\w./_-]+$", "^head -n \\d+ [\\w./_-]+$"],

	// Mid-string char class bracketed by literal terminator (safe)
	["^echo '[\\w :,.{}\"-]+'$", "^echo '[\\w :,.{}\"-]+'$"],

	// Fixed length escaped dot
	["^echo \\.txt$", "^echo \\.txt$"],

	// Alternation of literals
	["^(ls|pwd|whoami)$", "^(ls|pwd|whoami)$"],

	// Whitespace + bounded word
	["^echo\\s+\\w+$", "^echo\\s+\\w+$"],
];

for (const [name, regex, reasonRe] of REJECT) {
	test(`reject: ${name}`, () => {
		const r = lintBashRegex(regex);
		assert.equal(r.ok, false, `expected reject for /${regex}/ but it passed`);
		assert.match(
			r.reason ?? "",
			reasonRe,
			`reason mismatch for /${regex}/: got "${r.reason}"`,
		);
	});
}

for (const [name, regex] of ACCEPT) {
	test(`accept: ${name}`, () => {
		const r = lintBashRegex(regex);
		assert.equal(
			r.ok,
			true,
			`expected accept for /${regex}/ but rejected: ${r.reason}`,
		);
	});
}

// --- Sanity: each REJECT case can be rewritten as an ACCEPT case ---
test("user case can be rewritten safely", () => {
	const original = "^(echo.*|restish.*|head.*)$";
	assert.equal(lintBashRegex(original).ok, false);

	// Tighter version with specific structure for each branch
	const tightened = "^(echo '[\\w :,.{}\"-]+'|restish exa search -o json|head -\\d+)$";
	const r = lintBashRegex(tightened);
	assert.equal(r.ok, true, `tightened version should pass: ${r.reason}`);
});
