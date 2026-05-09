---
name: rust-book
description: "Search 'The Rust Programming Language' (the official book) cloned at ~/repos/book. Use when answering Rust questions, looking up concepts (ownership, lifetimes, traits, async basics), or citing canonical explanations. Offline-first — no network."
user_invocable: true
---

The book lives at `~/repos/book/src/`. Every chapter is plain markdown.

## File naming

`chXX-YY-topic.md` where `XX` = chapter, `YY` = section. `chXX-00-…` is the chapter intro.
`appendix-NN-…md` for appendices.

## Quick chapter map

- 03 — variables, types, functions, control flow
- 04 — **ownership, references, slices**
- 05 — structs
- 06 — enums, `match`, `if let`
- 07 — modules, paths, `use`
- 08 — common collections (`Vec`, `String`, `HashMap`)
- 09 — error handling (`Result`, `?`, `panic!`)
- 10 — **generics, traits, lifetimes**
- 11 — testing
- 13 — closures, iterators
- 15 — smart pointers (`Box`, `Rc`, `RefCell`)
- 16 — concurrency (`thread`, `Send`/`Sync`, channels)
- 17 — **async/await, futures**
- 18 — OOP features
- 19 — patterns and matching
- 20 — advanced features (`unsafe`, advanced traits/types/lifetimes, macros)
- appendix-03 — derivable traits cheat sheet

## How to search

Always prefer ripgrep over reading whole files. Use `-l` to list files, then read the matches.

```bash
# Find files mentioning a term
rg -l "interior mutability" ~/repos/book/src/

# Get matches with context
rg -C 3 "Send \+ Sync" ~/repos/book/src/

# Restrict to a chapter
rg "trait object" ~/repos/book/src/ch10-*

# Headings only (good for navigation)
rg '^#' ~/repos/book/src/ch04-*
```

## Workflow

1. Identify the concept the user is asking about.
2. Map to a chapter using the table above; if unsure, `rg -l <term>` across `~/repos/book/src/`.
3. Read the relevant section with the Read tool. Prefer the smallest range that answers the question.
4. Cite as `Book ch. X.Y` (e.g. "Book ch. 4.2 — References and Borrowing") so the user can re-find it.
5. Quote sparingly (a sentence or two), then explain in your own words.

## When to skip

- Async ecosystem specifics (tokio, reqwest, sqlx) — not in the book. Use `cargo doc` or the crate's own docs.
- Latest edition idioms post-2024 — verify against the current `~/repos/book` clone date if uncertain.
