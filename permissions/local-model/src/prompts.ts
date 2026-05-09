export const BASH_SEGMENT_PROMPT = `You generate Python-compatible regular expressions for matching shell command segments.

Output format — exactly these two tags, in this order, nothing else:
<reason>one short sentence (under 20 words) explaining what the regex covers and what it deliberately excludes</reason>
<regex>^...$</regex>

THE COVERAGE RULE: your regex MUST full-match the input. If it does not, you have failed.

NEVER use these patterns — they match shell metacharacters (>, <, *, backtick, $) and let attackers redirect output, glob, or substitute commands:
- \`.*\`, \`.+\`, \`.{N}\`, \`.{N,M}\`  (dot matches ANY character including shell metas)
- \`\\S+\`, \`\\S*\`, \`\\W+\`, \`\\W*\`  (non-whitespace includes shell metas)
- A trailing character class like \`[^foo]+\` or \`[a-z>]+\` that includes any of: > < * \` $

USE these instead:
- \`[\\w./~_-]+\` for path-like arguments (filenames, packages, paths including \`~/\`) — safe, excludes shell metas
- \`[\\w-]+\` for words/identifiers (config keys, branch names)
- \`--?[\\w-]+(=[\\w./~@:_-]+)?\` for command flags — matches \`-x\`, \`--xy\`, AND \`--xy=value\` syntax
- \`[^']+\` for content inside single quotes; \`[^"]+\` for content inside double quotes
- Bounded literal alternations like \`(start|build|test)\`

FLAGS WITH VALUES: many CLIs accept \`--flag value\` (space-separated) AND \`--flag=value\` (equals-separated) interchangeably. Use \`--?[\\w-]+(=[\\w./~@:_-]+)?\` to match both forms in one pattern.

POSITIONAL ARGS: when a command takes a positional argument (like a package name) potentially mixed with flags (e.g., \`npm install -g lodash --registry=https://...\`), put the positional pattern between two flag-repeat groups: \`( --?[\\w-]+(=[\\w./~@:_-]+)?)*( [\\w@./~_-]+)?( --?[\\w-]+(=[\\w./~@:_-]+)?)*\`

IMPORTANT: if you cannot tell what the variable part is (e.g., the command takes a config-key argument like \`npm config get registry\`), STAY EXACT — match only the literal command. Do not invent generalizations you're not sure about.

URL RULE: when a regex includes a URL, keep the SCHEME and HOST literal (escape dots with \`\\\\.\`). Generalize only the path. Generalizing the host means a future "curl https://evil.com/..." would auto-approve; that is a security regression.

Wrong: \`https://[\\w.-]+/[\\w./~_-]+\`  (host generalized — matches any host)
Right: \`https://registry\\.npmjs\\.org(/[\\w./~_-]*)?\`  (host literal, trailing path is optional — matches \`registry.npmjs.org\` AND \`registry.npmjs.org/lodash\`)

Always wrap the path in \`(/[\\w./~_-]*)?\` (with the leading \`/\` INSIDE the optional group). This way the regex matches the host with or without a trailing path. If you write \`host/[\\w./~_-]*\` (path required, just possibly empty), it will fail to match a URL that ends at the host with no slash.

Decide first whether to GENERALIZE or stay EXACT, then write the regex.

GENERALIZE the argument values when the binary+subcommand combination is safe. Keep the binary and subcommand literal; replace variable parts with the safe character classes above.

STAY EXACT when:
- The command is destructive (rm, mv to system paths, dd, chmod -R)
- The command writes to specific paths (echo > /file, tee /file)
- The command's positional argument identifies WHAT TO TRUST: package installs (npm install, pip install, brew install, apt install, cargo install, gem install, go get), image pulls (docker pull, podman pull). Different packages/images have different trust levels — approving lodash should NOT approve some other package. Keep the package or image name LITERAL; flags can still vary.
- You cannot tell which part of the command is "the variable"

Examples (generalize cases):

Input: git status
<reason>Allows git status with any combination of short/long flags; bounded char classes prevent shell metas.</reason>
<regex>^git status( --?[\\w-]+)*$</regex>

Input: cat package.json
<reason>Allows cat with any path-like filename argument; excludes redirections and globs.</reason>
<regex>^cat [\\w./~_-]+$</regex>

Input: cat ~/.npmrc
<reason>Allows cat for any path including home-relative; bounded class excludes shell metas.</reason>
<regex>^cat [\\w./~_-]+$</regex>

Input: ls
<reason>Allows ls with optional flags and one optional path argument.</reason>
<regex>^ls( --?[\\w-]+)*( [\\w./~_-]+)?$</regex>

Input: npm install lodash
<reason>Package installs identify what to trust — package name stays literal so installing a different package re-prompts. Flags can vary.</reason>
<regex>^npm install( --?[\\w-]+(=[\\w./~@:_-]+)?)* lodash( --?[\\w-]+(=[\\w./~@:_-]+)?)*$</regex>

Input: npm install -g lodash --registry=https://registry.npmjs.org
<reason>Same as above — lodash kept literal, flags flexible including --flag=value form.</reason>
<regex>^npm install( --?[\\w-]+(=[\\w./~@:_-]+)?)* lodash( --?[\\w-]+(=[\\w./~@:_-]+)?)*$</regex>

Input: pip install requests
<reason>Same package-install treatment — requests literal, flags flexible.</reason>
<regex>^pip install( --?[\\w-]+(=[\\w./~@:_-]+)?)* requests( --?[\\w-]+(=[\\w./~@:_-]+)?)*$</regex>

Input: docker ps
<reason>Allows docker ps with any flags; excludes other docker subcommands and shell metas.</reason>
<regex>^docker ps( --?[\\w-]+)*$</regex>

Input: grep -r 'TODO' src
<reason>Allows grep -r with any single-quoted pattern and one path-like target directory.</reason>
<regex>^grep -r '[^']+' [\\w./~_-]+$</regex>

Input: find . -name '*.ts'
<reason>Allows find with any path-like start and any single-quoted -name pattern.</reason>
<regex>^find [\\w./~_-]+ -name '[^']+'$</regex>

Input: curl https://api.github.com/users/octocat
<reason>Allows curl with flags to api.github.com; host is literal — different hosts must be approved separately. Path optional.</reason>
<regex>^curl( --?[\\w-]+)* https://api\\.github\\.com(/[\\w./~_-]*)?$</regex>

Input: curl -sI https://registry.npmjs.org/lodash
<reason>Allows curl with flags to registry.npmjs.org; host stays literal so other registries do not auto-approve. Path optional.</reason>
<regex>^curl( --?[\\w-]+)* https://registry\\.npmjs\\.org(/[\\w./~_-]*)?$</regex>

Input: curl https://registry.npmjs.org
<reason>Same host as the previous example, no path; the optional path group covers both shapes with one rule.</reason>
<regex>^curl( --?[\\w-]+)* https://registry\\.npmjs\\.org(/[\\w./~_-]*)?$</regex>

Input: python3 script.py
<reason>Allows python3 with any .py file path; excludes -c inline code.</reason>
<regex>^python3 [\\w./~_-]+\\.py$</regex>

Input: cargo build
<reason>Allows cargo build with any flags and path arguments; excludes other cargo subcommands like publish.</reason>
<regex>^cargo build( --?[\\w-]+)*( [\\w./~_-]+)*$</regex>

Examples (stay-exact cases):

Input: rm -rf /tmp/build
<reason>Destructive command — kept exact, do not generalize the path.</reason>
<regex>^rm -rf /tmp/build$</regex>

Input: git push origin main
<reason>Push has side effects on remote — kept exact for this branch only.</reason>
<regex>^git push origin main$</regex>

Input: echo hello
<reason>Echo can be used for redirection writes — kept exact rather than generalize.</reason>
<regex>^echo hello$</regex>

Input: npm config get registry
<reason>Config-key argument; not sure which keys are safe so stay exact for this key.</reason>
<regex>^npm config get registry$</regex>`;

export const BASH_LADDER_PROMPT = `You generate a LADDER of EXACTLY 3 regex variants for matching a single bash command segment, from MOST GENERAL to MOST SPECIFIC.

OUTPUT FORMAT — exactly three blocks, in order, nothing else before/between/after:
<v1><reason>one short sentence</reason><regex>^...$</regex></v1>
<v2><reason>one short sentence</reason><regex>^...$</regex></v2>
<v3><reason>one short sentence</reason><regex>^...$</regex></v3>

STEP 0 — DETECT-FIRST CHECK (do this BEFORE anything else):

Look at the FIRST WORD of the input (the binary). If it is one of these, you MUST write the EXACT LITERAL regex (no character classes, no flag wildcards, no path wildcards) for ALL THREE variants:

  rm  rmdir  mv  cp  dd  shred  chmod  chown  chgrp  sudo  doas  su  mkfs  fdisk  parted  mount  umount  kill  killall  pkill  systemctl  service  reboot  shutdown  halt  poweroff

If the input contains \`> /\`, \`>> /\`, \`tee /\`, or any output redirection to a file path, ALSO write the exact literal regex three times.

If the input is \`git push\` (any args), write the exact literal regex three times.

These are HARD LOCKS. v1 = v2 = v3 = the input itself escaped. The user CAN approve only the exact command they typed; broadening is not safe even with explicit consent.

If the input survives Step 0 (binary is NOT in the lock list), proceed to the ladder rules below.

THE LADDER:
- v1 (LOOSE — broad trust): broaden as much as is safe. The user opts into v1 deliberately to grant wide trust. Generalize package/image names for installs (any package), generalize positional path arguments for non-destructive commands, generalize flags broadly. v1 should accept noticeably more inputs than v2.
- v2 (DEFAULT — safe default): the cursor lands here. Keep the binary, subcommand, and key positional arguments literal — the SPECIFIC trusted artifact. Flags can vary. This is the rule a security-conscious user would pick by default.
- v3 (TIGHT — exact): the original input as a literal regex with regex-special chars escaped. Maximum specificity.

v1 MUST be strictly broader than v2 when broadening is safe. v1 = v2 only when the HARD LOCKS below leave no room (e.g. destructive commands).

THE COVERAGE RULE: every variant MUST full-match the input. Validation rejects any variant that does not match. Test each one mentally against the input before emitting.

THE SUBSET RULE: every input v3 accepts must also be accepted by v2 and v1; every input v2 accepts must also be accepted by v1. Never narrow by EXCLUDING the input — that breaks coverage. Negative lookaheads like \`(?!lodash)\` are forbidden because they would exclude the input itself.

HARD LOCKS (apply at ALL THREE levels — even v1 cannot relax these):
- URL HOSTS stay character-for-character literal at every level (escape dots with \`\\\\.\`). Wildcarding the host means evil.com auto-approves. NEVER. Generalize only the path part of URLs.
- GIT PUSH targets (remote name and ref) stay exact at every level.
- DESTRUCTIVE COMMANDS (rm, rmdir, mv to system paths, dd, chmod -R, chown -R) keep their full structure exact at every level. v1 = v2 = v3 = literal.
- OUTPUT REDIRECTIONS to specific files (echo > /file, tee /file) stay exact at every level.

V1 MAY RELAX (v2/v3 still keep these literal):
- Package and image names for installs (npm install, pip install, brew install, cargo install, gem install, apt install, apt-get install, docker pull, podman pull). At v1 use \`[\\w@/.-]+\` for the package; at v2/v3 keep the package name literal.
- Positional path arguments for non-destructive commands (cat, head, tail, less, file, stat, wc, grep target, find target, ls target, cd, pushd). At v1 use \`[\\w./~_-]+\`; at v2/v3 tighten by structure (require \`~/\`, require extension, etc.).
- Subcommand-specific options (e.g. \`git log\` with arbitrary args) at v1; tighten options at v2.

NEVER USE these patterns at any level — they match shell metacharacters (>, <, *, backtick, $):
- \`.*\`, \`.+\`, \`.{N}\`, \`.{N,M}\`, \`\\S+\`, \`\\S*\`, \`\\W+\`, \`\\W*\`
- A trailing character class like \`[^foo]+\` or \`[a-z>]+\` that includes any of: > < * \` $

USE these instead:
- \`[\\w./~_-]+\` for paths/filenames
- \`[\\w@/.-]+\` for package or image names (allows scoped names like @types/node and registry/owner/image)
- \`[\\w-]+\` for words/identifiers
- \`--?[\\w-]+(=[\\w./~@:_-]+)?\` for flags (covers \`-x\`, \`--xy\`, AND \`--xy=value\`)
- \`[^']+\` inside single quotes; \`[^"]+\` inside double quotes

NEVER enumerate alternatives like \`(pwd|sh|bash|zsh|...)\` or \`(-r|-rf|-d|-i|-v|...)\`. Use a single bounded character class instead. Enumerations balloon the regex and are usually wrong.

EXAMPLES (study these — they show v1 strictly broader than v2 except for HARD LOCKS):

Input: npm install -g lodash
<v1><reason>Loose: any npm install package with any flags. Approves broad npm install trust.</reason><regex>^npm install( --?[\\w-]+(=[\\w./~@:_-]+)?)* [\\w@/.-]+( --?[\\w-]+(=[\\w./~@:_-]+)?)*$</regex></v1>
<v2><reason>Lodash literal — different packages have different trust. Flags can vary.</reason><regex>^npm install( --?[\\w-]+(=[\\w./~@:_-]+)?)* lodash( --?[\\w-]+(=[\\w./~@:_-]+)?)*$</regex></v2>
<v3><reason>Locked to exact literal command.</reason><regex>^npm install -g lodash$</regex></v3>

Input: cat ~/.npmrc
<v1><reason>Loose: cat with any path-like filename.</reason><regex>^cat [\\w./~_-]+$</regex></v1>
<v2><reason>Cat any hidden file in home directory.</reason><regex>^cat ~/\\.[\\w./_-]+$</regex></v2>
<v3><reason>Locked to the exact literal path.</reason><regex>^cat ~/\\.npmrc$</regex></v3>

Input: ls -la /Users/andrey/repos/dotfiles
<v1><reason>Loose: ls with any flags and any path-like target.</reason><regex>^ls( --?[\\w-]+)*( [\\w./~_-]+)?$</regex></v1>
<v2><reason>ls -la flag literal; allow any path target.</reason><regex>^ls -la [\\w./~_-]+$</regex></v2>
<v3><reason>Locked to exact literal command and path.</reason><regex>^ls -la /Users/andrey/repos/dotfiles$</regex></v3>

Input: pwd
<v1><reason>Loose: pwd with optional flags.</reason><regex>^pwd( --?[\\w-]+)*$</regex></v1>
<v2><reason>pwd with no flags or just -L / -P.</reason><regex>^pwd( -[LP])?$</regex></v2>
<v3><reason>Locked to exact literal command.</reason><regex>^pwd$</regex></v3>

Input: git status
<v1><reason>Allows git status with any combination of flags.</reason><regex>^git status( --?[\\w-]+)*$</regex></v1>
<v2><reason>Allows git status with no flags or one --short / -s flag.</reason><regex>^git status( --short| -s)?$</regex></v2>
<v3><reason>Locked to exact literal command.</reason><regex>^git status$</regex></v3>

Input: curl -sI https://registry.npmjs.org/lodash
<v1><reason>Loose: any curl flags and any path on registry.npmjs.org. HARD LOCK: host stays literal at every level.</reason><regex>^curl( --?[\\w-]+)* https://registry\\.npmjs\\.org(/[\\w./~_-]*)?$</regex></v1>
<v2><reason>Same host, only paths starting with /lodash.</reason><regex>^curl( --?[\\w-]+)* https://registry\\.npmjs\\.org/lodash[\\w./~_-]*$</regex></v2>
<v3><reason>Locked to exact literal command.</reason><regex>^curl -sI https://registry\\.npmjs\\.org/lodash$</regex></v3>

Input: rm -rf /tmp/build
<v1><reason>HARD LOCK: destructive command — kept exact at every level.</reason><regex>^rm -rf /tmp/build$</regex></v1>
<v2><reason>HARD LOCK: destructive command — kept exact at every level.</reason><regex>^rm -rf /tmp/build$</regex></v2>
<v3><reason>Locked to exact literal command.</reason><regex>^rm -rf /tmp/build$</regex></v3>

Input: git push origin main
<v1><reason>HARD LOCK: git push remote ref — kept exact at every level.</reason><regex>^git push origin main$</regex></v1>
<v2><reason>HARD LOCK: git push remote ref — kept exact at every level.</reason><regex>^git push origin main$</regex></v2>
<v3><reason>Locked to exact literal command.</reason><regex>^git push origin main$</regex></v3>`;

export const NET_GLOB_PROMPT = `You generate glob patterns for network actions in a Cedar-style policy.

Action format: net:METHOD:host/path
Glob syntax: * matches a single path segment (no / no :); ** matches anything.

Output format — exactly these two tags, in this order, nothing else:
<reason>one short sentence (under 20 words) explaining what the glob covers and what it deliberately keeps literal</reason>
<glob>net:METHOD:host/path</glob>

THE COVERAGE RULE: your glob MUST match the input action. If it does not, you have failed.

Specifically: appending "/**" to a path that does not end with "/" produces a glob that does NOT match the input. The glob "host/foo/**" requires a "/" after "foo" to match anything — it will NOT match plain "host/foo".

Decide between three modes per input:

MODE A: Generalize the data tail with "/**". Use ONLY when the path is a known list-style endpoint where the trailing segment is clearly data (e.g., /repos/<owner>/<repo>, /users/<name>, /<package>).

MODE B: Stay exact (glob equals input). Use for:
- API entry endpoints with no clear "data tail" (/graphql, /search, /chat/completions)
- Webhooks, signed URLs, paths containing secrets/tokens
- DELETE methods on any path
- /admin/, /organization/, /internal/ paths regardless of method
- Any URL where the path looks specific/deliberate rather than parameterized

MODE C: Generalize a middle path segment with "*". Rarely needed; only if a single segment in the middle is variable.

Never wildcard the host. Never wildcard the method or scheme.

Examples (mode A — generalize tail):

Input: net:GET:api.github.com/repos/foo/bar
<reason>Repo path tail is data; host and method stay literal.</reason>
<glob>net:GET:api.github.com/repos/**</glob>

Input: net:GET:api.github.com/users/octocat
<reason>User name is data; trailing segment generalized to **.</reason>
<glob>net:GET:api.github.com/users/**</glob>

Input: net:GET:registry.npmjs.org/lodash
<reason>Package name is data; host stays literal so other registries do not auto-approve.</reason>
<glob>net:GET:registry.npmjs.org/**</glob>

Examples (mode B — exact):

Input: net:POST:api.linear.app/graphql
<reason>API entry endpoint — kept exact; no data tail to generalize.</reason>
<glob>net:POST:api.linear.app/graphql</glob>

Input: net:POST:api.openai.com/v1/chat/completions
<reason>API entry endpoint — kept exact; path is deliberate.</reason>
<glob>net:POST:api.openai.com/v1/chat/completions</glob>

Input: net:POST:hooks.slack.com/services/T0/B0/secret
<reason>Webhook path contains a secret; kept exact.</reason>
<glob>net:POST:hooks.slack.com/services/T0/B0/secret</glob>

Input: net:DELETE:api.example.com/admin/users/42
<reason>DELETE on an admin path — kept exact.</reason>
<glob>net:DELETE:api.example.com/admin/users/42</glob>

Input: net:POST:api.exa.ai/search
<reason>Search API entry endpoint — kept exact.</reason>
<glob>net:POST:api.exa.ai/search</glob>`;
