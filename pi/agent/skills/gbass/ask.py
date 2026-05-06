#!/usr/bin/env python3
"""gbass — iterate with Gemini about a GarageBand project bounce."""
from __future__ import annotations
import argparse, base64, json, os, plistlib, subprocess, sys, tempfile, urllib.error, urllib.request
from pathlib import Path

GB_DIR = Path.home() / "Music" / "GarageBand"
SESSIONS_DIR = Path.home() / ".claude" / "skills" / "gbass" / "sessions"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent"
MIME = {
    ".mp3": "audio/mp3", ".wav": "audio/wav", ".aif": "audio/aiff", ".aiff": "audio/aiff",
    ".flac": "audio/flac", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".aac": "audio/aac",
}
SEARCH_DIRS = [GB_DIR, GB_DIR / "Bounces", Path.home() / "Music", Path.home() / "Desktop"]

SYSTEM_PROMPT = (
    "You are a patient producer mentoring a TOTAL GarageBand beginner. They have never "
    "added a software instrument, EQ'd a track, or used a bus. Assume nothing.\n"
    "Rules: no flattery, no preamble, no buffet of options. Pick the SINGLE highest-leverage "
    "next move and walk them through it in GarageBand — name the exact menu items, buttons, "
    "and panels to click (e.g. 'click + at the bottom of the track list, choose Software "
    "Instrument'). Define any jargon in 5 words max when you first use it. 180 words max.\n"
    "When the user follows up, build on the previous turn — don't repeat advice you've already "
    "given. If they share a new bounce (audio attachment), it supersedes the prior one."
)


def find_band(name: str) -> Path:
    p = GB_DIR / f"{name}.band"
    if not p.is_dir():
        sys.exit(f"error: {p} not found")
    return p


def read_metadata(band: Path) -> dict:
    meta: dict = {}
    md_plist = band / "Alternatives" / "000" / "MetaData.plist"
    if md_plist.exists():
        md = plistlib.loads(md_plist.read_bytes())
        meta["tempo"] = md.get("BeatsPerMinute")
        meta["time_signature"] = f"{md.get('SongSignatureNumerator')}/{md.get('SongSignatureDenominator')}"
        meta["key"] = f"{md.get('SongKey')} {md.get('SongGenderKey')}"
        meta["sample_rate"] = md.get("SampleRate")
        meta["num_tracks"] = md.get("NumberOfTracks")
        meta["audio_files"] = md.get("AudioFiles", [])
    info_plist = band / "Resources" / "ProjectInformation.plist"
    if info_plist.exists():
        info = plistlib.loads(info_plist.read_bytes())
        meta["last_saved_from"] = info.get("LastSavedFrom")
    return meta


def find_bounce(name: str) -> Path | None:
    candidates: list[Path] = []
    for root in SEARCH_DIRS:
        if not root.is_dir():
            continue
        for ext in MIME:
            candidates.extend(root.glob(f"{name}*{ext}"))
            candidates.extend(root.glob(f"{name}*{ext.upper()}"))
    candidates = [c for c in candidates if ".band/" not in str(c)]
    return max(candidates, key=lambda p: p.stat().st_mtime) if candidates else None


def prepare(src: Path) -> tuple[Path, str]:
    ext = src.suffix.lower()
    if ext in MIME:
        return src, MIME[ext]
    out = Path(tempfile.gettempdir()) / f"gbass_{src.stem}.wav"
    subprocess.run(
        ["afconvert", "-f", "WAVE", "-d", "LEI16@44100", str(src), str(out)],
        check=True, capture_output=True,
    )
    return out, "audio/wav"


def session_path(project: str) -> Path:
    return SESSIONS_DIR / f"{project}.json"


def load_session(project: str) -> dict:
    f = session_path(project)
    if not f.exists():
        return {"contents": [], "last_bounce": None, "last_bounce_mtime": 0}
    try:
        return json.loads(f.read_text())
    except json.JSONDecodeError:
        return {"contents": [], "last_bounce": None, "last_bounce_mtime": 0}


def save_session(project: str, session: dict) -> None:
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    session_path(project).write_text(json.dumps(session))


def call_gemini(contents: list[dict], key: str) -> str:
    payload = {
        "system_instruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": contents,
    }
    req = urllib.request.Request(
        GEMINI_URL,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "X-goog-api-key": key},
    )
    try:
        body = json.loads(urllib.request.urlopen(req).read())
    except urllib.error.HTTPError as e:
        sys.exit(f"gemini error {e.code}: {e.read().decode()[:600]}")
    parts = [p["text"] for c in body.get("candidates", [])
             for p in c.get("content", {}).get("parts", []) if "text" in p]
    return "\n".join(parts) if parts else json.dumps(body, indent=2)


def main() -> None:
    ap = argparse.ArgumentParser(description="Iterate with Gemini about a GarageBand project.")
    ap.add_argument("project", help="project name (without .band)")
    ap.add_argument("question", nargs="?",
                    default="What's the single highest-leverage next move on this track?")
    ap.add_argument("--new", action="store_true", help="start a fresh session (discards history)")
    ap.add_argument("--reset", action="store_true", help="delete session and exit")
    ap.add_argument("--show", action="store_true", help="print the session history and exit")
    args = ap.parse_args()

    if args.reset:
        p = session_path(args.project)
        if p.exists(): p.unlink()
        print(f"reset session for {args.project}")
        return

    if args.show:
        sess = load_session(args.project)
        for i, turn in enumerate(sess["contents"]):
            text_bits = [p.get("text", "[audio]") for p in turn["parts"]]
            print(f"--- turn {i} ({turn['role']}) ---")
            print("\n".join(text_bits))
        return

    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        sys.exit("error: GEMINI_API_KEY not set (add to ~/.zshrc and restart shell)")

    band = find_band(args.project)
    meta = read_metadata(band)
    session = load_session(args.project) if not args.new else {
        "contents": [], "last_bounce": None, "last_bounce_mtime": 0,
    }

    bounce = find_bounce(args.project)
    bounce_mtime = bounce.stat().st_mtime if bounce else 0
    bounce_changed = bounce and bounce_mtime > session.get("last_bounce_mtime", 0)

    if not session["contents"] and not bounce:
        sys.exit(
            f"error: no bounced audio found for '{args.project}' and no prior session.\n"
            f"  in GarageBand: Share → Export Song to Disk… → save as {args.project}.mp3\n"
            f"  searched: {', '.join(str(d) for d in SEARCH_DIRS if d.is_dir())}"
        )

    is_first_turn = not session["contents"]
    parts: list[dict] = []
    if is_first_turn:
        parts.append({"text": f"Project metadata: {json.dumps(meta, default=str)}"})
    elif bounce_changed:
        parts.append({"text": "I've made changes and re-bounced. The new audio is attached — analyze this version, not the previous one."})

    if bounce_changed:
        audio, mime = prepare(bounce)
        b64 = base64.b64encode(audio.read_bytes()).decode()
        parts.append({"inline_data": {"mime_type": mime, "data": b64}})
        session["last_bounce"] = str(bounce)
        session["last_bounce_mtime"] = bounce_mtime

    parts.append({"text": args.question})
    session["contents"].append({"role": "user", "parts": parts})

    response = call_gemini(session["contents"], key)
    session["contents"].append({"role": "model", "parts": [{"text": response}]})
    save_session(args.project, session)

    user_turns = sum(1 for c in session["contents"] if c["role"] == "user")
    summary = f"{meta.get('key')}, {meta.get('tempo')} BPM, {meta.get('time_signature')}, {meta.get('num_tracks')} tracks"
    bounce_tag = "updated" if bounce_changed else "cached from earlier turn"
    print(f"# {args.project}  ·  turn {user_turns}")
    if bounce: print(f"bounce: {bounce} ({bounce_tag})")
    print(f"meta:   {summary}\n")
    print(response)


if __name__ == "__main__":
    main()
