---
name: pi-internals
description: "Reference for hacking on pi (the @mariozechner/pi-coding-agent CLI). Covers the monorepo layout, where the installed code and bundled docs live on this Mac, key resource locations (skills, extensions, prompts, themes, packages), and the extension API surface. Use when building or debugging pi extensions/skills/prompts/themes offline."
user_invocable: true
---

# Pi internals — local reference

## What pi is

`pi` is the CLI from the **pi-mono** monorepo (`badlogic/pi-mono`, MIT). The published npm package is **`@mariozechner/pi-coding-agent`** (NOT `@earendil-works/...` — the README's package names are aspirational; npm uses the `@mariozechner` scope). Install on this machine: Homebrew-managed npm global.

Sibling packages in the monorepo:

| Package (npm) | Role |
|---|---|
| `@mariozechner/pi-coding-agent` | Coding agent CLI (`pi`) — what we extend |
| `@mariozechner/pi-agent-core` | Agent runtime (loop, state machine, tool calling, transports) |
| `@mariozechner/pi-ai` | Unified multi-provider LLM API (OpenAI/Anthropic/Google/…) |
| `@mariozechner/pi-tui` | Terminal UI library (differential rendering, components, overlays) |
| `@mariozechner/pi-web-ui` | Web components for chat UIs (not used by CLI) |

## Where everything lives on THIS machine

### Installed package (the offline goldmine)

```
/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/
├── dist/                          # compiled JS + .d.ts (read these for API surface)
│   ├── cli.js                     # entry point (linked at /opt/homebrew/bin/pi)
│   ├── index.{js,d.ts}            # public exports — start here for types
│   ├── core/                      # agent core, hooks, export-html
│   │   └── hooks/                 # subpath export: "@mariozechner/pi-coding-agent/hooks"
│   ├── modes/                     # interactive, print, rpc, sdk
│   ├── config.js                  # config dir resolution (.pi)
│   └── migrations.js
├── docs/                          # full markdown docs (26 files, ~10k lines) — READ THESE
├── examples/
│   ├── extensions/                # ~60 working extension examples
│   ├── sdk/                       # SDK usage examples
│   └── rpc-extension-ui.ts
├── node_modules/@mariozechner/    # bundled siblings
│   ├── pi-agent-core/
│   ├── pi-ai/
│   └── pi-tui/
└── package.json                   # exports map: "." and "./hooks"
```

CLI binary: `/opt/homebrew/bin/pi` → `../lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js`

### Per-user config (this is OUR dotfiles repo)

`~/.pi` → `/Users/andrey/repos/dotfiles/pi` (symlink). Pi's global config dir is `~/.pi/agent/`:

```
~/.pi/agent/
├── settings.json          # global settings (see docs/settings.md)
├── auth.json              # provider credentials
├── models.json            # custom model entries
├── AGENTS.md              # global system prompt addendum (loaded into context)
├── bin/                   # binaries on PATH while pi runs (rg, fd here)
├── extensions/            # auto-discovered .ts extensions (per user)
├── skills/                # auto-discovered SKILL.md skills (per user)
├── sessions/              # JSONL session files
└── pi-crash.log
```

### Project-local overrides (when in a repo)

```
.pi/
├── settings.json          # overrides global; nested objects merge
├── extensions/            # auto-discovered project extensions
└── skills/                # auto-discovered project skills
.agents/skills/            # also discovered (cross-harness convention)
```

## Local docs index — what to read for what

All paths under `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/`:

| File | When to read |
|---|---|
| `index.md` | Entry point, links everything |
| `quickstart.md`, `usage.md` | First run, slash commands, CLI flags |
| `settings.md` | Every config knob, with defaults |
| `extensions.md` (~2600 lines) | **The big one.** Events, ExtensionAPI, ExtensionContext, custom tools, custom UI, mode behavior |
| `skills.md` | Skill format, frontmatter, discovery rules, Agent Skills spec |
| `prompt-templates.md` | `/cmd` style reusable prompts |
| `themes.md` | Theme JSON format, custom themes |
| `packages.md` | Sharing extensions/skills/prompts/themes via npm/git as "pi packages" |
| `models.md`, `providers.md`, `custom-provider.md` | Add models/providers, OAuth flows |
| `compaction.md` | Auto-compaction behavior + custom compaction extensions |
| `sessions.md`, `session-format.md` | JSONL session format, SessionManager API, branching |
| `sdk.md` | Embed pi as a Node library |
| `rpc.md` | stdin/stdout JSONL integration |
| `json.md` | Structured event stream from print mode |
| `tui.md` | Build custom TUI components for extensions |
| `keybindings.md` | Default + custom keybindings |
| `development.md` | Local pi-mono dev setup |

## Resource discovery model

Five resource types are loaded from many sources, in this priority order:

1. CLI flags (`--extension`, `--skill`, `--prompt`, `--theme`) — additive, survive `--no-*`
2. Project `.pi/settings.json` (overrides global)
3. Global `~/.pi/agent/settings.json`
4. Auto-discovery from conventional dirs (see locations above)
5. Pi packages (npm/git) listed under `packages` in settings

Resource arrays in settings support globs and `+include` / `-exclude` / `!exclude` syntax.

`packages` entries can be strings (`"pi-skills"`, `"npm:foo@1"`, `"git:github.com/u/r@v1"`) or objects that filter which resource types load from that package.

## Extension API at a glance

Entry contract — file exports a default factory:

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.on("session_start",   async (e, ctx) => { /* ... */ });
  pi.on("tool_call",       async (e, ctx) => { /* return {block, reason} to veto */ });
  pi.on("tool_call_result",async (e, ctx) => { /* observe / mutate */ });

  pi.registerTool({ name, label, description, parameters: Type.Object({...}), execute });
  pi.registerCommand("name", { description, handler });
  pi.registerShortcut("ctrl+x", { ... });
  pi.registerFlag("my-flag", { ... });
  pi.registerProvider("id", { ... });
  pi.appendEntry({ ... });        // persistent state in session JSONL
  pi.sendUserMessage("hi");
}
```

Factory may be `async` — pi awaits it before `session_start`. Loaded via [jiti](https://github.com/unjs/jiti), so `.ts` runs without a build step.

### Available imports inside an extension

| Module | Use |
|---|---|
| `@mariozechner/pi-coding-agent` | `ExtensionAPI`, `ExtensionContext`, event types |
| `@mariozechner/pi-coding-agent/hooks` | Subpath export — hook helpers |
| `@mariozechner/pi-ai` | LLM helpers (`StringEnum` for Google-compat enums) |
| `@mariozechner/pi-tui` | TUI components for custom rendering / overlays |
| `typebox` | Tool parameter schemas |
| `node:*` builtins | yes |
| Any npm package | drop a `package.json` next to extension, `npm install` |

For pi packages distributed via npm/git, runtime deps must be in `dependencies` (not `devDependencies`) — packages install with `--omit=dev`.

### `ctx.ui` (ExtensionContext UI surface)

Use these instead of `console.log` — they go through the TUI:

- `ctx.ui.notify(msg, "info"|"success"|"warn"|"error")`
- `ctx.ui.confirm(title, body) → Promise<boolean>`
- `ctx.ui.select(title, options) → Promise<choice>`
- `ctx.ui.input(prompt) → Promise<string>`
- `ctx.ui.custom(component)` — full TUI component with keyboard
- `ctx.ui.setStatus(id, text)` — footer line
- `ctx.ui.setWidget(id, lines, {placement})` — block above/below editor
- `ctx.ui.setFooter`, `setHeader`, `setEditorText`, `setEditorComponent`, `setHiddenThinkingLabel`, `setWorkingIndicator`

### Events (non-exhaustive — see `docs/extensions.md` § Events)

- Lifecycle: `session_start`, `session_end`, `shutdown`
- Resources: `resources_discover`
- Agent: `input`, `turn_start`, `turn_end`, `model_select`, `compaction`
- Tool: `tool_call` (block/modify), `tool_call_result`, `user_bash`
- UI: editor / autocomplete hooks

A handler returning `{ block: true, reason }` from `tool_call` vetoes the call.

## Skill structure (recap)

```
skill-name/
├── SKILL.md          # frontmatter (name, description) + instructions
├── scripts/          # executable helpers, called via relative paths
├── references/       # extra docs the model loads on demand
└── assets/
```

Frontmatter `name` MUST match parent dir, lowercase a-z/0-9/`-`, ≤64 chars. `description` ≤1024 chars and decides when the model loads the skill — be specific. Optional: `license`, `compatibility`, `metadata`, `allowed-tools`, `disable-model-invocation`.

Discovery: top-level `.md` files in `~/.pi/agent/skills/` and `.pi/skills/` are also accepted as single-file skills; everywhere else, only directories with `SKILL.md`.

## Worked examples to crib from

`/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/examples/extensions/`:

- **Smallest**: `hello.ts`, `pirate.ts`, `notify.ts`
- **Tool veto / safety**: `permission-gate.ts`, `protected-paths.ts`, `dirty-repo-guard.ts`, `confirm-destructive.ts`
- **Custom tools**: `todo.ts`, `truncated-tool.ts`, `dynamic-tools.ts`, `structured-output.ts`, `tool-override.ts`, `subagent/`
- **Custom UI**: `question.ts`, `questionnaire.ts`, `modal-editor.ts`, `snake.ts`, `space-invaders.ts`, `doom-overlay/`
- **Commands**: `commands.ts`, `handoff.ts`, `preset.ts`, `plan-mode/`, `shutdown-command.ts`
- **Rendering**: `built-in-tool-renderer.ts`, `minimal-mode.ts`, `message-renderer.ts`, `custom-footer.ts`, `custom-header.ts`, `status-line.ts`
- **Compaction / system prompt**: `custom-compaction.ts`, `summarize.ts`, `prompt-customizer.ts`, `claude-rules.ts`
- **Provider/model**: `custom-provider-anthropic/`, `custom-provider-gitlab-duo/`, `provider-payload.ts`, `model-status.ts`
- **Git**: `git-checkpoint.ts`, `auto-commit-on-exit.ts`
- **External integration**: `ssh.ts`, `interactive-shell.ts`, `inline-bash.ts`, `file-trigger.ts`, `bash-spawn-hook.ts`, `event-bus.ts`
- **Sandboxing**: `sandbox/`

`README.md` in that directory has one-line descriptions for all of them.

## Workflow for building a new extension offline

1. Pick the closest example in `examples/extensions/` and copy it into `~/.pi/agent/extensions/<name>.ts` (or `<name>/index.ts`).
2. Type signatures: read `dist/index.d.ts` and `dist/core/hooks/index.d.ts` from the installed package.
3. Iterate with `/reload` inside a running pi session (auto-discovered locations only). For one-off testing of an arbitrary path, `pi -e ./path.ts`.
4. Crash logs land in `~/.pi/agent/pi-crash.log`.

## Gotchas

- `~/.pi/agent` here is a symlink into the dotfiles repo — anything written under `~/.pi/agent/{extensions,skills,settings.json}` is version-controlled.
- The bundled `node_modules/@mariozechner/{pi-agent-core,pi-ai,pi-tui}` are the SAME source the docs reference as separate packages — read their `dist/*.d.ts` for types not exported from `pi-coding-agent`.
- Settings paths in `~/.pi/agent/settings.json` resolve relative to `~/.pi/agent`; in `.pi/settings.json` relative to `.pi`. Absolute and `~` work everywhere.
- `pi install` packages run `npm install --omit=dev` — runtime deps must live under `dependencies`.
- `--no-skills` / `--no-extensions` disable auto-discovery but `--skill` / `--extension` flags still load.

## Upstream pointers (for when online again)

- Repo: https://github.com/badlogic/pi-mono
- Extensions doc: `packages/coding-agent/docs/extensions.md`
- Examples: `packages/coding-agent/examples/extensions/`
- DeepWiki (architecture overview): https://deepwiki.com/badlogic/pi-mono
- Public skill repos: `badlogic/pi-skills`, `anthropics/skills`
