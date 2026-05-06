---
name: restish
description: "Make API calls using restish CLI with pre-configured APIs. Currently configured: Exa (web search, content extraction, research). Use when you need to call REST APIs via the command line."
---

# restish CLI

`restish` is a CLI HTTP client that auto-generates commands from OpenAPI specs. APIs are pre-configured in `~/Library/Application Support/restish/apis.json`.

## Configured APIs

### Exa (`restish exa`)

Web search, content extraction, and research API.

**Commands:**
- `restish exa search` — Embeddings-based web search
- `restish exa get-contents` — Fetch full page contents from URLs
- `restish exa find-similar` — Find pages similar to a URL
- `restish exa answer` — AI-generated answer with citations
- `restish exa research-tasks-create` — Create async deep research task
- `restish exa research-tasks-list` — List research tasks
- `restish exa research-controller-v0-get-research-task ID` — Get task result

Use `restish exa COMMAND --help` for full parameter details.

## restish Syntax

**Body shorthand:** `key: value, key2: value2`
**Arrays:** `key[]: val1, key[]: val2`
**Nested:** `parent.child: value`
**Output format:** `-o json`, `-o table`
**Filter:** `-f "results[].title"`
**Verbose:** `-v`

## Adding New APIs

Edit `~/Library/Application Support/restish/apis.json`:

```json
{
  "myapi": {
    "base": "https://api.example.com",
    "spec_files": ["https://example.com/openapi.yaml"],
    "profiles": {
      "default": {
        "headers": { "Authorization": "Bearer TOKEN" }
      }
    }
  }
}
```

Then `restish myapi --help` lists all operations.

$ARGUMENTS
