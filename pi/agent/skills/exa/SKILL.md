---
name: exa
description: "Search the web, fetch pages, find similar content, get AI answers, and run deep research using the Exa API via restish."
user_invocable: true
---

# Exa via restish

Auth is pre-configured. All commands use `restish exa`.

## Two ways to call: inline vs. stdin JSON body

**Inline `key: value` form** — fine for simple calls (one query string, scalar params):

```bash
restish exa search query: "..." numResults: 5 text: true -o json
```

Inline syntax breaks down whenever a request needs an array (`ids`, `urls`, `includeDomains`, `excludeDomains`). All inline variants I tried failed:

| Attempt | Result |
|---|---|
| `"ids[]": "URL"` | restish emits non-JSON error (downstream `python3 -c` parse fails silently) |
| `noglob ids[]: "URL"` | `ERROR: Caught error: Expected '}' but found {` |
| `noglob 'ids[]: ["URL"]'` | API replies `expected string, received array at "ids"` (restish mangled the body) |
| `ids: "URL"` (no brackets) | Same `Expected '}'` parse error |

**Stdin JSON body form (PREFERRED for anything non-trivial)** — pipe a JSON object on stdin. This is the canonical path per `restish exa <cmd> --help` (look for `Examples: restish <cmd> <input.json`). Works for every command and is the only reliable way to send array params:

```bash
# Fetch full text of specific URLs
echo '{"ids":["https://example.com/a","https://example.com/b"],"text":true}' \
  | restish exa get-contents -o json

# Search with domain filtering (alternative to site: in query)
echo '{"query":"obsidian wiki","numResults":5,"text":true,"includeDomains":["github.com"]}' \
  | restish exa search -o json

# Find-similar / answer / research-tasks-create — same pattern
echo '{"url":"https://...","numResults":5,"text":true}' | restish exa find-similar -o json
echo '{"query":"...","text":true}' | restish exa answer -o json
```

For complex bodies, write to a file and use `<input.json` — keeps shell quoting sane.

## Syntax rules (inline form)

- **No commas** between params — use spaces only
- **Array params don't work inline** — use stdin JSON body (above)
- **`site:domain.com` in the query string** is a quick alternative to `includeDomains` for single-domain searches
- **JMESPath `-f`** does NOT work — restish requires filters starting with `body`, `headers`, etc. Pipe to `jq` or python instead
- **`-o json`** should always be used for programmatic access

## Commands (inline-friendly examples)

```bash
restish exa search query: "..." numResults: 5 text: true -o json
restish exa search query: "..." type: "deep" category: "news" -o json
restish exa search query: "..." startPublishedDate: "2025-01-01T00:00:00Z" -o json
restish exa search query: "site:github.com keywords" numResults: 5 -o json
restish exa find-similar url: "https://..." numResults: 5 text: true -o json
restish exa answer query: "..." text: true -o json
restish exa research-tasks-create instructions: "..."
restish exa research-controller-v0-get-research-task TASK_ID
```

For `get-contents` and any call with arrays, use the stdin form.

## Extracting results

`-f` JMESPath doesn't work, pipe to python or jq:

```bash
restish exa search query: "..." -o json 2>&1 | python3 -c "
import json,sys
data=json.load(sys.stdin)
for r in data.get('results',[]):
    print(r.get('title',''), '|', r.get('url',''))
"
```

**Debugging tip:** if the python pipe blows up with `JSONDecodeError: Expecting value: line 1 column 1`, restish printed an error message instead of JSON. Drop the python pipe and run the bare command (or pipe to `head -50`) to see the actual error — the `2>&1 | python3` chain swallows it. Common causes: malformed inline array param, missing required field, expired auth.

**Tip:** when you only need text from a few URLs, search results with `text: true` already include the body — often you can skip `get-contents` entirely by searching for `site:exact.domain.com unique terms from the page`.

## Key options

- **type**: instant, fast, auto (default), neural, deep, deep-reasoning
- **category**: company, research paper, news, pdf, github, personal site, people, financial report

## User request

$ARGUMENTS
