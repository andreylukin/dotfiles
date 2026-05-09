import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, evaluateBash, matches, parsePolicy, regexCoversSegments } from "./csp.js";

test("matches: * matches single segment, not / or :", () => {
	assert.equal(matches("net:*:api.github.com/users", "net:GET:api.github.com/users"), true);
	assert.equal(matches("net:*:api.github.com/users", "net:POST:api.github.com/users"), true);
	assert.equal(matches("net:*:api.github.com/users", "net:GET:api.github.com/users/x"), false);
});

test("matches: ** matches across slashes", () => {
	assert.equal(matches("net:*:api.github.com/**", "net:GET:api.github.com/"), true);
	assert.equal(matches("net:*:api.github.com/**", "net:GET:api.github.com/users/me"), true);
	assert.equal(matches("net:*:api.github.com/**", "net:GET:other.com/users"), false);
});

test("matches: file action", () => {
	assert.equal(matches("file:write:/etc/**", "file:write:/etc/passwd"), true);
	assert.equal(matches("file:write:/etc/**", "file:write:/home/x"), false);
});

test("evaluate: permit only -> allow", () => {
	const policy = parsePolicy(`permit (action == "net:*:api.github.com/**");`);
	assert.equal(evaluate("net:GET:api.github.com/zen", [policy]).decision, "allow");
});

test("evaluate: forbid overrides permit (forbid > permit)", () => {
	const policy = parsePolicy(`
		permit (action == "net:*:api.github.com/**");
		forbid (action == "net:*:api.github.com/admin/**");
	`);
	const r = evaluate("net:GET:api.github.com/admin/users", [policy]);
	assert.equal(r.decision, "deny");
	assert.match(r.reason, /forbid/);
});

test("evaluate: forbid wins regardless of declaration order", () => {
	const policy = parsePolicy(`
		forbid (action == "net:*:api.github.com/admin/**");
		permit (action == "net:*:api.github.com/**");
	`);
	assert.equal(evaluate("net:GET:api.github.com/admin/x", [policy]).decision, "deny");
});

test("evaluate: unknown action -> default deny", () => {
	const policy = parsePolicy(`permit (action == "net:*:api.github.com/**");`);
	const r = evaluate("net:GET:unknown.com/x", [policy]);
	assert.equal(r.decision, "deny");
	assert.equal(r.reason, "default deny");
});

test("evaluate: empty policy list -> default deny", () => {
	assert.equal(evaluate("net:GET:any.com/", []).decision, "deny");
});

test("parsePolicy: @name annotation captured", () => {
	const policy = parsePolicy(`@name("test")\npermit (action == "net:*:x.com/**");`);
	assert.equal(policy.name, "test");
	assert.equal(policy.rules.length, 1);
});

test("parsePolicy: comments and blank lines skipped", () => {
	const policy = parsePolicy(`
		# top comment
		// also a comment

		permit (action == "net:*:x.com/**");
	`);
	assert.equal(policy.rules.length, 1);
});

test("parsePolicy: throws on unparseable line", () => {
	assert.throws(() => parsePolicy(`grant (action == "x");`), /csp parse error/);
});

test("evaluateBash: regex full-matches single segment -> allow", () => {
	const policy = parsePolicy(`permit (action == "bash:^git \\w+$");`);
	assert.equal(evaluateBash(["git status"], [policy]).decision, "allow");
	assert.equal(evaluateBash(["git log"], [policy]).decision, "allow");
});

test("evaluateBash: each segment needs SOME permit rule", () => {
	const policy = parsePolicy(`permit (action == "bash:^ls$");`);
	assert.equal(evaluateBash(["ls"], [policy]).decision, "allow");
	assert.equal(evaluateBash(["ls", "ls -la"], [policy]).decision, "deny"); // "ls -la" not covered
});

test("evaluateBash: separate permit rules collectively cover multi-segment commands", () => {
	const policy = parsePolicy(`
		permit (action == "bash:^ls$");
		permit (action == "bash:^pwd$");
	`);
	assert.equal(evaluateBash(["ls", "pwd"], [policy]).decision, "allow");
	assert.equal(evaluateBash(["pwd", "ls"], [policy]).decision, "allow");
	assert.equal(evaluateBash(["ls", "rm"], [policy]).decision, "deny"); // "rm" uncovered
});

test("evaluateBash: forbid overrides permit", () => {
	const policy = parsePolicy(`
		permit (action == "bash:^git .*$");
		forbid (action == "bash:^git push.*$");
	`);
	assert.equal(evaluateBash(["git status"], [policy]).decision, "allow");
	const r = evaluateBash(["git push origin main"], [policy]);
	assert.equal(r.decision, "deny");
	assert.match(r.reason, /forbid/);
});

test("evaluateBash: forbid on any segment overrides permit on others", () => {
	const policy = parsePolicy(`
		permit (action == "bash:^ls$");
		permit (action == "bash:^rm.*$");
		forbid (action == "bash:^rm -rf .*$");
	`);
	const r = evaluateBash(["ls", "rm -rf /"], [policy]);
	assert.equal(r.decision, "deny");
	assert.match(r.reason, /forbid/);
});

test("evaluateBash: unmatched -> default deny", () => {
	const policy = parsePolicy(`permit (action == "bash:^ls$");`);
	const r = evaluateBash(["rm -rf /"], [policy]);
	assert.equal(r.decision, "deny");
	assert.equal(r.reason, "default deny");
});

test("evaluateBash: empty segments -> deny", () => {
	const policy = parsePolicy(`permit (action == "bash:^.*$");`);
	assert.equal(evaluateBash([], [policy]).decision, "deny");
});

test("evaluateBash: invalid regex in rule is skipped, not thrown", () => {
	const policy = parsePolicy(`permit (action == "bash:[unclosed");`);
	assert.equal(evaluateBash(["echo hi"], [policy]).decision, "deny");
});

test("evaluate: ignores bash: rules when matching net actions", () => {
	const policy = parsePolicy(`
		permit (action == "bash:^.*$");
		permit (action == "net:*:api.github.com/**");
	`);
	const r = evaluate("net:GET:api.github.com/zen", [policy]);
	assert.equal(r.decision, "allow");
	assert.match(r.matchedRule?.pattern ?? "", /^net:/);
});

test("regexCoversSegments: true when regex full-matches every segment", () => {
	assert.equal(regexCoversSegments("^(ls|pwd)$", ["ls", "pwd"]), true);
	assert.equal(regexCoversSegments("^ls$", ["ls", "rm"]), false);
	assert.equal(regexCoversSegments("^ls$", []), false);
	assert.equal(regexCoversSegments("[invalid", ["ls"]), false);
});

// Dangerous-case tests — segment arrays are what tree-sitter-bash produces for
// these inputs. The check-segments.mjs script regenerates these from the live
// parser if you want to verify empirically without running the commands.
test("evaluateBash danger: cat $(rm -rf /) — subshell extracted, denied", () => {
	const policy = parsePolicy(`
		@name("bash-trivial")
		permit (action == "bash:^cat [^;|&$]+$");
	`);
	// tree-sitter splits this into two command nodes
	const segments = ["cat $(rm -rf /)", "rm -rf /"];
	const r = evaluateBash(segments, [policy]);
	assert.equal(r.decision, "deny");
	// Outer segment fails the cat regex (because of $); inner has no permit.
	// Default deny because no permit covers either.
});

test("evaluateBash danger: ls; rm -rf / — sequence extracted, denied", () => {
	const policy = parsePolicy(`permit (action == "bash:^ls$");`);
	const segments = ["ls", "rm -rf /"]; // tree-sitter splits on ;
	assert.equal(evaluateBash(segments, [policy]).decision, "deny");
});

test("evaluateBash danger: forbid catches rm -rf even when wrapped in subshell", () => {
	const policy = parsePolicy(`
		permit (action == "bash:^cat .+$");
		forbid (action == "bash:^rm -rf .*$");
	`);
	// Even if the LLM lies about its regex, forbid scans every extracted segment
	const segments = ["cat $(rm -rf /)", "rm -rf /"];
	const r = evaluateBash(segments, [policy]);
	assert.equal(r.decision, "deny");
	assert.match(r.reason, /forbid/);
	assert.match(r.reason, /rm -rf \//);
});
