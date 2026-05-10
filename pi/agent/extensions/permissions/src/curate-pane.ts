import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { matchesKey, visibleWidth } from "@mariozechner/pi-tui";
import type { Policy, Rule } from "@permissions/shared";
import { countHitsByRule } from "./audit.js";

const C = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	cyan: "\x1b[36m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	magenta: "\x1b[35m",
	bgSelected: "\x1b[48;5;238m",
	bgCursor: "\x1b[48;5;236m",
	fgSelected: "\x1b[38;5;255m",
};

export type PaneEvent =
	| { kind: "quit" }
	| { kind: "move"; indices: number[]; cursor: number; selected: number[] }
	| { kind: "new"; indices: number[]; cursor: number; selected: number[] }
	| { kind: "chat"; cursor: number; selected: number[] }
	| { kind: "delete"; indices: number[]; cursor: number; selected: number[] }
	| { kind: "toggle-template"; name: string; loaded: boolean; cursor: number; selected: number[] };

export interface PaneState {
	cursor: number;
	selected: Set<number>;
}

export interface AvailableTemplate {
	name: string;
	origin: "user" | "bundled";
}

type CursorTarget =
	| { kind: "rule"; ruleIndex: number }
	| { kind: "template"; name: string; loaded: boolean; origin: "user" | "bundled" | "loaded-only" };

export class SessionPane implements Component {
	private tui: TUI;
	private rules: Rule[];
	private templates: Policy[];
	private availableTemplates: AvailableTemplate[];
	private cursor = 0;
	private selected = new Set<number>();
	private hits: Map<string, number>;
	private done: (e: PaneEvent) => void;
	private status = "";
	private statusFlash = 0;

	constructor(
		tui: TUI,
		rules: Rule[],
		templates: Policy[],
		availableTemplates: AvailableTemplate[],
		state: PaneState,
		done: (e: PaneEvent) => void,
	) {
		this.tui = tui;
		this.rules = rules;
		this.templates = templates;
		this.availableTemplates = availableTemplates;
		this.selected = new Set(state.selected);
		this.hits = countHitsByRule(rules, 1000);
		this.done = done;
		const total = this.totalRows();
		this.cursor = Math.min(state.cursor, Math.max(0, total - 1));
	}

	private templateRows(): { name: string; loaded: boolean; origin: "user" | "bundled" | "loaded-only" }[] {
		const loadedNames = new Set(this.templates.map((t) => t.name).filter((n): n is string => !!n));
		const merged = new Map<string, "user" | "bundled" | "loaded-only">();
		for (const t of this.availableTemplates) merged.set(t.name, t.origin);
		for (const n of loadedNames) if (!merged.has(n)) merged.set(n, "loaded-only");
		return [...merged.entries()]
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([name, origin]) => ({ name, loaded: loadedNames.has(name), origin }));
	}

	private totalRows(): number {
		return this.rules.length + this.templateRows().length;
	}

	private resolveCursor(): CursorTarget | null {
		if (this.cursor < this.rules.length) {
			return { kind: "rule", ruleIndex: this.cursor };
		}
		const templates = this.templateRows();
		const tIdx = this.cursor - this.rules.length;
		const t = templates[tIdx];
		if (!t) return null;
		return { kind: "template", name: t.name, loaded: t.loaded, origin: t.origin };
	}

	private flash(msg: string): void {
		this.status = msg;
		this.statusFlash = Date.now();
		this.tui.requestRender();
	}

	private touch(): void {
		this.tui.requestRender();
	}

	/** Wrap a styled row in cursor-highlight bg, re-applying after every internal reset. */
	private withCursorBg(row: string): string {
		const reapplied = row.replace(/\x1b\[0m/g, `\x1b[0m${C.bgCursor}`);
		return `${C.bgCursor}${reapplied}${C.reset}`;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const inner = Math.max(40, width - 4); // 2 chars border + 2 chars padding on each side
		const body: string[] = [];

		// Section: session rules
		body.push(`${C.bold}${C.cyan}session${C.reset}  ${C.dim}${this.rules.length} rule${this.rules.length === 1 ? "" : "s"} · ${this.selected.size} selected${C.reset}`);
		if (this.rules.length === 0) {
			body.push(`${C.dim}(empty — accept "Always allow" prompts to populate, then return here)${C.reset}`);
		} else {
			const headerHits = "hits";
			const headerLeft = `${C.dim}  #   effect  pattern${C.reset}`;
			const padLen = Math.max(2, inner - visibleWidth(`  #   effect  pattern`) - headerHits.length);
			body.push(`${headerLeft}${" ".repeat(padLen)}${C.dim}${headerHits}${C.reset}`);
			this.rules.forEach((r, i) => body.push(this.renderRow(r, i, inner)));
		}

		body.push("");

		// Section: available templates
		body.push(`${C.bold}${C.cyan}templates${C.reset}  ${C.dim}● loaded   ○ available   (b) bundled    space to toggle${C.reset}`);
		const templates = this.templateRows();
		if (templates.length === 0) {
			body.push(`${C.dim}(no templates discovered)${C.reset}`);
		} else {
			const loadedCount = (n: string): number =>
				this.templates.find((t) => t.name === n)?.rules.length ?? 0;
			templates.forEach((t, i) => {
				const isCursor = this.cursor === this.rules.length + i;
				const bullet = t.loaded ? `${C.green}●${C.reset}` : `${C.dim}○${C.reset}`;
				const nameStr = t.loaded ? t.name : `${C.dim}${t.name}${C.reset}`;
				const originTag = t.origin === "bundled" ? ` ${C.dim}(b)${C.reset}` : "";
				const ruleStr = t.loaded
					? `  ${C.dim}${loadedCount(t.name)} rule${loadedCount(t.name) === 1 ? "" : "s"}${C.reset}`
					: "";
				const row = `  ${bullet} ${nameStr}${originTag}${ruleStr}`;
				body.push(isCursor ? this.withCursorBg(row) : row);
			});
		}

		body.push("");

		// Footer
		const footerKeys = [
			`${C.bold}↑↓${C.reset}/${C.bold}jk${C.reset} move`,
			`${C.bold}space${C.reset} toggle (rule: select · tpl: load)`,
			`${C.bold}a${C.reset}/${C.bold}A${C.reset} all/none`,
			`${C.bold}m${C.reset} move→tpl`,
			`${C.bold}n${C.reset} new tpl`,
			`${C.bold}c${C.reset} chat`,
			`${C.bold}d${C.reset} drop rule`,
			`${C.bold}q${C.reset} close`,
		];
		body.push(`${C.dim}${footerKeys.join("  ")}${C.reset}`);

		if (this.status && Date.now() - this.statusFlash < 4000) {
			body.push(`${C.yellow}› ${this.status}${C.reset}`);
		}

		return wrapBorder(body, inner, "Permissions — curate");
	}

	private renderRow(rule: Rule, index: number, width: number): string {
		const isCursor = index === this.cursor;
		const isSel = this.selected.has(index);
		const marker = isSel ? `${C.green}✓${C.reset}` : " ";
		const num = (index + 1).toString().padStart(2);
		const eff = rule.effect === "permit" ? `${C.green}permit${C.reset}` : `${C.red}forbid${C.reset}`;
		const hitN = this.hits.get(rule.pattern) ?? 0;
		const hitStr = hitN > 0 ? `${C.dim}${hitN.toString().padStart(4)}${C.reset}` : `${C.dim}   0${C.reset}`;

		const prefix = `${marker} ${num}  ${eff}  `;
		const suffix = `  ${hitStr}`;
		const visiblePrefix = `  ${num}  ${rule.effect}  `;
		const visibleSuffix = `  ${hitN.toString().padStart(4)}`;
		const room = Math.max(20, width - visiblePrefix.length - visibleSuffix.length - 1);
		let pat = rule.pattern;
		if (pat.length > room) pat = `${pat.slice(0, room - 1)}…`;
		const padding = " ".repeat(Math.max(0, room - pat.length));

		const base = `${prefix}${pat}${padding}${suffix}`;
		return isCursor ? this.withCursorBg(base) : base;
	}

	handleInput(data: string): void {
		const total = this.totalRows();
		// Movement
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			if (total > 0) this.cursor = Math.min(this.cursor + 1, total - 1);
			this.touch();
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			if (total > 0) this.cursor = Math.max(this.cursor - 1, 0);
			this.touch();
			return;
		}
		if (matchesKey(data, "home") || matchesKey(data, "g")) {
			this.cursor = 0;
			this.touch();
			return;
		}
		if (matchesKey(data, "end") || matchesKey(data, "shift+g")) {
			this.cursor = Math.max(0, total - 1);
			this.touch();
			return;
		}
		// space / enter — context-sensitive toggle on the focused row.
		// Rule row: toggle selection. Template row: toggle load/unload.
		if (matchesKey(data, "space") || matchesKey(data, "enter") || matchesKey(data, "return")) {
			const t = this.resolveCursor();
			if (!t) return;
			if (t.kind === "rule") {
				if (this.selected.has(t.ruleIndex)) this.selected.delete(t.ruleIndex);
				else this.selected.add(t.ruleIndex);
				this.touch();
				return;
			}
			this.done({
				kind: "toggle-template",
				name: t.name,
				loaded: t.loaded,
				cursor: this.cursor,
				selected: [...this.selected],
			});
			return;
		}
		if (matchesKey(data, "a")) {
			for (let i = 0; i < this.rules.length; i++) this.selected.add(i);
			this.touch();
			return;
		}
		if (matchesKey(data, "shift+a")) {
			this.selected.clear();
			this.touch();
			return;
		}
		// Quit
		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
			this.done({ kind: "quit" });
			return;
		}
		// Rule-only operations (m/n/d). c (chat) is global.
		const indices = this.activeIndices();
		const stateOut = { cursor: this.cursor, selected: [...this.selected] };
		if (matchesKey(data, "m")) {
			if (indices.length === 0) {
				this.flash("focus a session rule first (or select rules with space)");
				return;
			}
			this.done({ kind: "move", indices, ...stateOut });
			return;
		}
		if (matchesKey(data, "n")) {
			if (indices.length === 0) {
				this.flash("focus a session rule first (or select rules with space)");
				return;
			}
			this.done({ kind: "new", indices, ...stateOut });
			return;
		}
		if (matchesKey(data, "c")) {
			this.done({ kind: "chat", ...stateOut });
			return;
		}
		if (matchesKey(data, "d")) {
			if (indices.length === 0) {
				this.flash("focus a session rule first");
				return;
			}
			this.done({ kind: "delete", indices, ...stateOut });
			return;
		}
	}

	/** Indices to act on: explicit selection, or the cursor row if it's a rule. */
	private activeIndices(): number[] {
		if (this.selected.size > 0) return [...this.selected].sort((a, b) => a - b);
		if (this.cursor < this.rules.length) return [this.cursor];
		return [];
	}
}

export async function runCuratePane(
	ctx: ExtensionContext,
	rules: Rule[],
	templates: Policy[],
	availableTemplates: AvailableTemplate[],
	state: PaneState,
): Promise<PaneEvent> {
	return ctx.ui.custom<PaneEvent>(
		(tui, _theme, _kb, done) => new SessionPane(tui, rules, templates, availableTemplates, state, done),
		{ overlay: true },
	);
}

/**
 * Wrap a list of pre-styled body lines in a unicode rounded-box border.
 * `inner` is the inner width (between left padding and right padding).
 * Each body line is right-padded with spaces (using visibleWidth so ANSI
 * codes don't throw off the count).
 */
function wrapBorder(body: string[], inner: number, title: string): string[] {
	const top = `${C.dim}╭─ ${C.reset}${C.bold}${C.magenta}${title}${C.reset} ${C.dim}${"─".repeat(Math.max(0, inner - title.length - 2))}╮${C.reset}`;
	const bot = `${C.dim}╰${"─".repeat(inner + 2)}╯${C.reset}`;
	const out: string[] = [top];
	for (const line of body) {
		// Hard-wrap lines that are wider than the inner width on visible width.
		const wrapped = wrapLineToWidth(line, inner);
		for (const w of wrapped) {
			const pad = Math.max(0, inner - visibleWidth(w));
			out.push(`${C.dim}│${C.reset} ${w}${" ".repeat(pad)} ${C.dim}│${C.reset}`);
		}
	}
	out.push(bot);
	return out;
}

/** Naive ANSI-aware wrap: split on spaces, reflow into chunks ≤ width. */
function wrapLineToWidth(line: string, width: number): string[] {
	if (visibleWidth(line) <= width) return [line];
	// Last-resort: hard slice per visible width using a simple ANSI-safe scan.
	const parts: string[] = [];
	let i = 0;
	let buf = "";
	let bufW = 0;
	while (i < line.length) {
		// Pass through ANSI escape sequences.
		if (line[i] === "\x1b") {
			const m = line.slice(i).match(/^\x1b\[[0-9;]*m/);
			if (m) {
				buf += m[0];
				i += m[0].length;
				continue;
			}
		}
		buf += line[i];
		bufW += 1;
		i += 1;
		if (bufW >= width) {
			parts.push(buf);
			buf = "";
			bufW = 0;
		}
	}
	if (buf) parts.push(buf);
	return parts;
}
