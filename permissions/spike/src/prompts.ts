export const BASH_SEGMENT_PROMPT = `You generate Python-compatible regular expressions for matching shell command segments.

Output ONLY the regex anchored with ^...$. No prose, no code fences, no explanation.

THE COVERAGE RULE: your regex MUST full-match the input. If it does not, you have failed.

Decide first whether to GENERALIZE or stay EXACT, then write the regex.

GENERALIZE the argument values (filenames, package names, paths, URLs) when the binary+subcommand combination is safe. The pattern is: keep the binary and subcommand literal; replace the variable part with a character class.

STAY EXACT when:
- The command is destructive (rm, mv to system paths, dd, chmod -R)
- The command writes to specific paths (echo > /file, tee /file)
- You cannot tell which part of the command is "the variable"

Examples (generalize cases):

Input: git status
Output: ^git status( .*)?$

Input: cat package.json
Output: ^cat [\\w./-]+$

Input: ls
Output: ^ls( .*)?$

Input: npm install lodash
Output: ^npm install( [\\w@/.-]+)?( --[\\w-]+)*$

Input: docker ps
Output: ^docker ps( .*)?$

Input: grep -r 'TODO' src
Output: ^grep -r '[^']+' [\\w./-]+$

Input: find . -name '*.ts'
Output: ^find [\\w./-]+ -name '[^']+'$

Input: curl https://api.github.com/users/octocat
Output: ^curl( -[\\w-]+)* https://[\\w.-]+/[\\w./-]+$

Input: python3 script.py
Output: ^python3 [\\w./-]+\\.py$

Input: cargo build
Output: ^cargo build([- ]+\\S+)*$

Examples (stay-exact cases):

Input: rm -rf /tmp/build
Output: ^rm -rf /tmp/build$

Input: git push origin main
Output: ^git push origin main$

Input: echo hello
Output: ^echo hello$`;

export const BASH_WHOLE_PROMPT = `You generate Python-compatible regular expressions for matching shell commands with multiple segments.

The command may have segments separated by &&, ||, ;, or |.

Output ONE regex anchored with ^...$. No prose, no code fences, no explanation.

The regex will be used as: every segment of an incoming command (after splitting on &&, ||, ;, |) must full-match this regex for the command to be approved.

Use alternation: ^(seg-pattern-1|seg-pattern-2|...)$

Each alternative covers ONE kind of segment from the input. Generalize argument values within each segment, not across binaries or subcommands.

Examples:

Input: ls && pwd
Output: ^(ls( .*)?|pwd)$

Input: cd src && npm test
Output: ^(cd [\\w./-]+|npm test( .*)?)$

Input: cat package.json | jq .name
Output: ^(cat [\\w./-]+|jq [\\w.\\-]+)$`;

export const NET_GLOB_PROMPT = `You generate glob patterns for network actions in a Cedar-style policy.

Action format: net:METHOD:host/path
Glob syntax: * matches a single path segment (no / no :); ** matches anything.

THE COVERAGE RULE: your output glob MUST match the input action. If it does not, you have failed.

Specifically: appending "/**" to a path that does not end with "/" produces a glob that does NOT match the input. The glob "host/foo/**" requires a "/" after "foo" to match anything — it will NOT match plain "host/foo".

Decide between three modes per input:

MODE A: Generalize the data tail with "/**". Use ONLY when the path is a known list-style endpoint where the trailing segment is clearly data (e.g., /repos/<owner>/<repo>, /users/<name>, /<package>).

MODE B: Stay exact (output equals input). Use for:
- API entry endpoints with no clear "data tail" (/graphql, /search, /chat/completions)
- Webhooks, signed URLs, paths containing secrets/tokens
- DELETE methods on any path
- /admin/, /organization/, /internal/ paths regardless of method
- Any URL where the path looks specific/deliberate rather than parameterized

MODE C: Generalize a middle path segment with "*". Rarely needed; only if a single segment in the middle is variable.

Output ONLY the glob. No prose, no fences. Never wildcard the host. Never wildcard the method.

Examples (mode A — generalize tail):

Input: net:GET:api.github.com/repos/foo/bar
Output: net:GET:api.github.com/repos/**

Input: net:GET:api.github.com/users/octocat
Output: net:GET:api.github.com/users/**

Input: net:GET:registry.npmjs.org/lodash
Output: net:GET:registry.npmjs.org/**

Examples (mode B — exact):

Input: net:POST:api.linear.app/graphql
Output: net:POST:api.linear.app/graphql

Input: net:POST:api.openai.com/v1/chat/completions
Output: net:POST:api.openai.com/v1/chat/completions

Input: net:POST:hooks.slack.com/services/T0/B0/secret
Output: net:POST:hooks.slack.com/services/T0/B0/secret

Input: net:DELETE:api.example.com/admin/users/42
Output: net:DELETE:api.example.com/admin/users/42

Input: net:POST:api.exa.ai/search
Output: net:POST:api.exa.ai/search`;
