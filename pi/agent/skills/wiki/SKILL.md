---
name: wiki
description: "Manage the personal wiki at ~/repos/wiki using llmwiki-cli. Use when asked to add, update, search, or query the wiki. You are the brain; the CLI is the hands."
user_invocable: true
---

Active wiki: `~/repos/wiki` (domain: personal). Install: `npm install -g llmwiki-cli`.

You are operating a wiki CLI. You decide what to create, connect, and update. The CLI reads, writes, searches, and manages files. It never calls any LLM API — it is a pure filesystem tool.

## Critical: `wiki write` takes JSON on stdin

```bash
wiki write wiki/concepts/topic.md <<'EOF'
{
  "title": "Topic Name",
  "description": "One-line summary",
  "tags": ["tag1", "tag2"],
  "source": "https://example.com",
  "content": "# Topic Name\n\nBody with [[wikilinks]] here."
}
EOF
```

Required: `title`, `content`. Optional: `description`, `tags` (array), `source` (valid URL), `created`/`updated` (ISO dates). Unknown keys are rejected.

To edit: `wiki read <path>` → revise in context → `wiki write` with full JSON (no append command).

## Directory structure

```
raw/           # immutable source docs
wiki/
  index.md     # auto-updated by wiki write/delete
  entities/    # people, orgs, products
  concepts/    # ideas, frameworks, theories
  sources/     # one summary per ingested source
  synthesis/   # cross-cutting analysis
```

Paths are relative to wiki root. Use kebab-case filenames.

## Workflows

**Ingest a source — always follow this order**

```bash
# 1. Save raw original (immutable, stays here forever)
wiki write raw/topic-name.md <<'EOF'
{"title":"topic-name-raw","content":"<full original text>"}
EOF

# 2. Compiled summary — ONE page per source, always wiki/sources/
wiki write wiki/sources/topic-name.md <<'EOF'
{"title":"Topic Name","tags":["tag"],"source":"https://...","content":"## Summary\n…"}
EOF

# 3. Extract entities (people, orgs, products) — create or update
wiki write wiki/entities/entity-name.md <<'EOF'
{"title":"Entity Name","content":"…"}
EOF

# 4. Extract concepts (ideas, frameworks) — create or update
wiki write wiki/concepts/concept-name.md <<'EOF'
{"title":"Concept Name","content":"…"}
EOF

# 5. wiki/synthesis/ ONLY for cross-cutting analysis across multiple sources
#    Do NOT put single-source summaries here.

# 6. Health check
wiki lint
```

**Directory rules (common mistake: putting single-source content in synthesis/)**

| Directory | Use for | NOT for |
|---|---|---|
| `raw/` | Original unmodified content | Anything compiled |
| `wiki/sources/` | Summary of one ingested source | Multi-source analysis |
| `wiki/entities/` | People, orgs, products | Concepts or ideas |
| `wiki/concepts/` | Ideas, frameworks, theories | Specific instances |
| `wiki/synthesis/` | Patterns across 2+ sources | First-time ingestion |

**Answer a question**
```bash
wiki search "query"
wiki read wiki/concepts/topic.md
wiki links wiki/concepts/topic.md
```

**Health check**
```bash
wiki lint
wiki orphans
wiki status
```

## Command reference

```bash
wiki read <path>                         # print page to stdout
wiki write <path>                        # JSON stdin → page
wiki delete <path>                       # remove page + index entry
wiki list [dir] [--tree] [--json]
wiki search <query> [-l N] [--json]
wiki links <path>                        # outbound + inbound
wiki backlinks <path>
wiki orphans
wiki lint [--json]
wiki status [--json]
wiki registry                            # list all wikis
wiki use [wiki-id]                       # switch active wiki
```

## Gotchas

- `wiki write` hangs if no stdin — always use a heredoc or pipe
- `source` must be a valid URL when present
- If "No wiki found": run `wiki use personal` or `cd ~/repos/wiki`
- `wiki search --all` searches across all registered wikis
