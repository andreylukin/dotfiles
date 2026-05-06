---
name: gbass
description: "Send a GarageBand project's bounced audio to Gemini for AI review. Trigger when the user asks about a GarageBand project by name, e.g. 'review Project1', 'what does Project1 sound like', 'ask gemini about MyDemo', '/gbass Project1'."
user_invocable: true
---

# gbass

Sends a GarageBand project to Gemini for producer-level review. Reads metadata from the `.band` plists and the most recent bounced audio file matching the project name.

## Usage

```bash
python3 ~/.claude/skills/gbass/ask.py <project-name> ["<question>"] [--new] [--reset] [--show]
```

- `<project-name>` matches `~/Music/GarageBand/<project-name>.band/`.
- `<question>` is optional. Default: ask for the highest-leverage next move.
- `--new` starts a fresh conversation (discards prior history for this project).
- `--reset` deletes the session and exits.
- `--show` prints the existing conversation history and exits.

## Multi-turn behavior

The script keeps a JSON conversation history per project at `~/.claude/skills/gbass/sessions/<project>.json`. Each call appends one user turn and one model turn. Gemini sees the full history, so follow-ups build on prior answers.

Audio handling:
- The bounce is sent on the first turn.
- Subsequent turns reuse it implicitly (no re-upload) unless a newer bounce file exists, in which case the new audio is sent with a "I re-bounced" marker.

## How to invoke

When the user references a GarageBand project by name and wants AI commentary:

1. Run `python3 ~/.claude/skills/gbass/ask.py "<project>" "<question>"`.
2. **Continue the same session** for follow-ups about the same project — do NOT pass `--new` unless the user explicitly asks to start over (e.g. "fresh take", "forget what we discussed").
3. Print the script's output verbatim — header (project, turn number, bounce path, key/tempo/tracks) plus Gemini's response.
4. If the script exits with "no bounced audio found", relay the message — the user must export from GarageBand first (`Share → Export Song to Disk…`).

## Where bounces are found

The script searches (most recent wins):
- `~/Music/GarageBand/`
- `~/Music/GarageBand/Bounces/`
- `~/Music/`
- `~/Desktop/`

…for files named `<project>*.{mp3,wav,m4a,aif,aiff,flac,ogg,aac}`.

## Requirements

- `GEMINI_API_KEY` env var (set in `~/.zshrc`).
- macOS `afconvert` (built-in) — only needed if a bounce is in a non-standard format.

## Notes

- Inline audio cap is ~20 MB request size. For long WAV bounces, prefer MP3 export from GarageBand.
- The script uses `gemini-flash-latest`. Edit `GEMINI_URL` in `ask.py` to switch models.
