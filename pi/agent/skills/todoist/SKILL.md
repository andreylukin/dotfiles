---
name: todoist
description: "Manage Todoist tasks, projects, sections, labels, and comments via restish. Use when the user wants to create/list/update/complete tasks, manage projects, or interact with their Todoist account."
user_invocable: true
---

# Todoist via restish

Auth is pre-configured. All commands use `restish todoist`. API: https://developer.todoist.com/api/v1

## Syntax rules

- **No commas** between params — space-separated (e.g. `content: "Buy milk" priority: 4`).
- **Body params** for POST/PUT: `key: value` pairs on the command line.
- **Query flags** use `--flag` form (e.g. `--project-id`, `--filter`).
- **Always use `-o json`** for programmatic parsing. Pipe to `python3`/`jq` — `-f` JMESPath is flaky.

## Commands

```bash
# --- Projects ---
restish todoist get-all-projects -o json
restish todoist get-project PROJECT_ID -o json
restish todoist create-project name: "Work" color: "blue" -o json
restish todoist update-project PROJECT_ID name: "New name" -o json
restish todoist delete-project PROJECT_ID

# --- Sections ---
restish todoist get-all-sections --project-id PROJECT_ID -o json
restish todoist create-section name: "Backlog" project_id: "PROJECT_ID" -o json
restish todoist update-section SECTION_ID name: "..." -o json
restish todoist delete-section SECTION_ID

# --- Tasks ---
restish todoist get-active-tasks -o json
restish todoist get-active-tasks --project-id PROJECT_ID --filter "today & p1" -o json
restish todoist get-active-task TASK_ID -o json
restish todoist create-task content: "Buy milk" due_string: "tomorrow 9am" priority: 3 project_id: "PID" labels: '["shopping"]' -o json
restish todoist update-task TASK_ID content: "..." priority: 4 -o json
restish todoist close-task TASK_ID      # mark complete
restish todoist reopen-task TASK_ID
restish todoist delete-task TASK_ID

# --- Labels ---
restish todoist get-all-personal-labels -o json
restish todoist create-personal-label name: "waiting" color: "yellow" -o json
restish todoist update-personal-label LABEL_ID name: "..." -o json
restish todoist delete-personal-label LABEL_ID

# --- Comments ---
restish todoist get-all-comments --task-id TASK_ID -o json
restish todoist create-comment task_id: "TID" content: "Note text" -o json
restish todoist update-comment COMMENT_ID content: "..." -o json
restish todoist delete-comment COMMENT_ID
```

## Task fields (create/update)

- `content` — task title (markdown ok).
- `description` — longer body.
- `due_string` — natural language: `"tomorrow"`, `"every monday"`, `"ev! 3 days"`.
- `due_date` — `YYYY-MM-DD`. `due_datetime` — RFC3339 UTC.
- `priority` — `1` (none) to `4` (urgent). Note: Todoist's UI shows P1 as urgent — API inverts this.
- `labels` — JSON array string: `'["home","urgent"]'`.
- `project_id`, `section_id`, `parent_id` — strings.
- `duration` + `duration_unit` (`minute` | `day`).

## Filter syntax (for `--filter`)

Same as Todoist app: `today`, `overdue`, `p1`, `@label`, `#project`, `&` (AND), `|` (OR), `!` (NOT).
Example: `"(today | overdue) & p1 & !@waiting"`.

## Parsing results

```bash
restish todoist get-active-tasks -o json 2>&1 | python3 -c "
import json, sys
for t in json.load(sys.stdin):
    print(f\"[{t['priority']}] {t['content']}  (due: {(t.get('due') or {}).get('string','-')})\")"
```

Project/section/label lists return `{results: [...], next_cursor: ...}` — iterate `data['results']`.

## Best practices (apply when creating/organizing tasks)

- **Capture to Inbox first** — omit `project_id` on quick adds; triage later.
- **Actionable verbs** — content should start with a verb ("Draft X", not "X").
- **One next action** per project; break bigger outcomes into sub-tasks (`parent_id`).
- **Priorities sparingly** — reserve `priority: 4` (P1 in UI) for "must happen today." If everything's urgent, nothing is.
- **Labels are contexts** (`@phone`, `@waiting`, `@deep-work`), orthogonal to projects. Use filters to combine them.
- **Due dates** — only set one if the task truly must happen that day. Avoid due-date inflation; it destroys trust in the Today view.
- **Recurring** — prefer `ev! 3 days` (next from completion) over `every 3 days` (strict cadence) for habits.

## Guidelines

- Confirm before bulk deletes or destructive ops.
- Prefer `close-task` over `delete-task` unless the user says "delete."
- For "add a task" requests, default to Inbox (omit `project_id`) unless project is specified.
- Present results concisely — not raw JSON.

## User request

$ARGUMENTS
