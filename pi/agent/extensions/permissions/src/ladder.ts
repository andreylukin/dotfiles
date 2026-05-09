import { type Component, type Focusable, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { BashProposal } from "@permissions/local-model";

/** Subset of pi's Theme used here. Matches render-bash.ts's RenderTheme. */
export interface LadderTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** Per-row decision the widget returns to the caller. */
export type RowDecision =
	| { kind: "existing" }
	| { kind: "allow-once" }
	| { kind: "deny-once" }
	| { kind: "always-allow"; variant: BashProposal | null }
	| { kind: "always-deny"; variant: BashProposal | null };

/** Per-row state machine. existing rows auto-settle; everything else is decidable. */
export type RowState = "pending" | "allow-once" | "deny-once" | "always-allow" | "always-deny";

export type ApprovalResult =
	| { action: "submit"; decisions: RowDecision[] }
	| { action: "cancel" };

/** Result the caller's refineFn returns. null means ollama is unreachable. */
export type RefineOutcome =
	| { ok: true; variant: BashProposal }
	| { ok: false; reason: string }
	| null;

export interface BashApprovalLadderInputs {
	command: string;
	rows: LadderRow[];
	theme: LadderTheme;
	done: (result: ApprovalResult) => void;
	/** Required for inline streaming refine — used to trigger redraws as tokens arrive. */
	tui: { requestRender(force?: boolean): void };
	/**
	 * Streams a refined regex from the model. Caller is responsible for
	 * validation; the returned variant must already pass safety checks.
	 * `onChunk` fires with the accumulated raw model output on each token.
	 */
	refineFn: (
		segmentText: string,
		currentRegex: string,
		directive: string,
		onChunk: (accumulated: string) => void,
		signal: AbortSignal,
	) => Promise<RefineOutcome>;
}

/**
 * One per parsed bash segment. `variants` is empty when source !== "proposed"
 * (existing-rule, model-rejected, or ollama-unavailable rows). Existing rows
 * are auto-settled and not part of the per-row decision flow.
 */
export interface LadderRow {
	segmentText: string;
	display: string;
	depth: number;
	kind: "shell" | "python";
	source: "existing" | "proposed" | "rejected" | "unavailable";
	existingRegex: string | null;
	rejectedRegex: string | null;
	variants: BashProposal[];
	variantIdx: number;
	risk: RiskLevel;
}

export type RiskLevel = "low" | "medium" | "high" | "critical";

/**
 * Unified bash approval widget with per-row decisions. Each refinable row
 * tracks its own state (pending / allow-once / always-allow / deny-once /
 * always-deny). Focused row's a/A/d/D set THAT row's state. ctrl+a / ctrl+d
 * set all pending rows at once for the homogeneous case. `r` opens a
 * free-form text refinement for the focused variant (round-trips through the
 * caller). Enter submits when no rows are pending. Esc cancels.
 *
 * Pure string render — same shape as pi-tui's built-in SelectList.
 */
export class BashApprovalLadder implements Component, Focusable {
	focused = false;
	private finished = false;
	private readonly command: string;
	private readonly rows: LadderRow[];
	private readonly theme: LadderTheme;
	private readonly done: (result: ApprovalResult) => void;
	private readonly tui: { requestRender(force?: boolean): void };
	private readonly refineFn: BashApprovalLadderInputs["refineFn"];
	/** Indices into `rows` of refinable rows (proposed / rejected / unavailable). Existing rows excluded. */
	private readonly refinableIdx: number[];
	/** Per-row state, indexed same as `rows`. Existing rows are always implicitly "always-allow"; they're never queried. */
	private readonly states: RowState[];
	private focusPos = 0;
	private flashMessage: string | null = null;

	/** Inline refine state machine. */
	private mode: "decide" | "refine-input" | "refine-streaming" = "decide";
	private refineDirective = "";
	private refineBuffer = "";
	private refineAbort: AbortController | null = null;
	private refineRowIdx: number | null = null;
	private refineVariantIdx: number | null = null;

	constructor(inputs: BashApprovalLadderInputs) {
		this.command = inputs.command;
		this.rows = inputs.rows;
		this.theme = inputs.theme;
		this.done = inputs.done;
		this.tui = inputs.tui;
		this.refineFn = inputs.refineFn;
		this.refinableIdx = this.rows
			.map((r, i) => (r.source === "existing" ? -1 : i))
			.filter((i) => i >= 0);
		this.states = this.rows.map((r) =>
			r.source === "existing" ? "always-allow" : "pending",
		);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const t = this.theme;
		const lines: string[] = [];
		lines.push(`${t.bold(t.fg("accent", "Permission (bash)"))}`);
		lines.push("");
		lines.push(`${t.bold(t.fg("accent", "command:"))}`);
		for (const cl of this.command.split("\n")) lines.push(`  ${cl}`);
		lines.push("");

		const tabbed = this.rows.length >= 2;
		if (tabbed) {
			this.renderTabStrip(lines, width);
			lines.push("");
			const focusedIdx = this.refinableIdx[this.focusPos];
			if (focusedIdx !== undefined) this.renderRowTabbed(lines, this.rows[focusedIdx], focusedIdx);
		} else {
			const pending = this.pendingCount();
			const segHeader = pending > 0
				? `segments (${this.rows.length})   ${t.fg("warning", `${pending} pending`)}`
				: `segments (${this.rows.length})   ${t.fg("success", "ready to submit")}`;
			lines.push(`${t.bold(t.fg("accent", segHeader))}`);
			this.rows.forEach((row, i) => this.renderRow(lines, row, i));
		}

		lines.push("");
		if (this.mode === "refine-input" || this.mode === "refine-streaming") {
			this.renderRefinePanel(lines);
		} else {
			const single = this.refinableIdx.length === 1;
			const pending = this.pendingCount();
			const submitHint = pending > 0 ? `[Enter] submit (${pending} pending)` : `[Enter] submit`;
			const hint1 = single
				? `[a] this call   [A] session allow   [d] block this call   [D] session deny   [←/→] variant   [r] refine with text`
				: `[a/A] allow / session allow   [d/D] block / session deny   [Tab/⇧Tab] segment   [←/→] variant   [r] refine`;
			const hint2 = single
				? `[Esc] cancel`
				: `[ctrl+a/ctrl+d] set all pending   ${submitHint}   [Esc] cancel`;
			lines.push(`  ${t.fg("muted", hint1)}`);
			lines.push(`  ${t.fg("muted", hint2)}`);
		}
		if (this.flashMessage) {
			lines.push(`  ${t.fg("warning", this.flashMessage)}`);
		}
		// pi-tui crashes if any rendered line's visible width exceeds the
		// terminal viewport. Long regexes and rich hint lines can overrun
		// narrow windows. Truncate every line as a safety net — full content
		// is recoverable via the result card and `r` (refine).
		return lines.map((line) =>
			visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line,
		);
	}

	private renderRow(lines: string[], row: LadderRow, index: number): void {
		const t = this.theme;
		const indent = "  ".repeat(row.depth);
		const focusedRowIdx = this.refinableIdx[this.focusPos] ?? -1;
		const isFocused = index === focusedRowIdx;
		const focusMarker = isFocused
			? t.fg("accent", "›")
			: this.refinableIdx.length > 1 && row.source !== "existing"
				? t.fg("muted", " ")
				: " ";
		const kindTag =
			row.kind === "python"
				? t.fg("muted", " py")
				: row.depth > 0
					? t.fg("muted", " sh")
					: "";
		const sourceTag = this.formatSourceTag(row);
		const riskBadge = this.formatRiskBadge(row);
		const stateBadge = this.formatStateBadge(row, index);
		const head = `${indent}  ${focusMarker} ${t.fg("muted", `[${index + 1}]`)}${kindTag} ${row.display.split("\n")[0]}  ${riskBadge} ${sourceTag}   ${stateBadge}`;
		lines.push(head);
		const contIndent = `${indent}        `;
		const tailLines = row.display.split("\n").slice(1);
		for (const tl of tailLines) lines.push(contIndent + tl);

		if (row.source === "proposed" && row.variants.length > 0) {
			const allEqual = row.variants.every((v) => v.regex === row.variants[0].regex);
			const hardLocked = row.risk === "critical";
			if (!allEqual) {
				lines.push(this.formatPositionLine(row, contIndent, isFocused));
			} else if (hardLocked) {
				lines.push(`${contIndent}${t.fg("warning", "(locked: all variants identical — generalization is not safe for this command)")}`);
			} else {
				lines.push(`${contIndent}${t.fg("warning", "(model produced only one viable variant — press [r] to refine with feedback)")}`);
			}
			const v = row.variants[row.variantIdx];
			if (v) {
				lines.push(`${contIndent}${t.fg("muted", "regex:")}  ${t.fg("success", v.regex)}`);
			}
		} else if (row.source === "existing" && row.existingRegex) {
			lines.push(`${contIndent}${t.fg("muted", "regex:")}  ${t.fg("success", row.existingRegex)}  ${t.fg("muted", "(existing rule)")}`);
		} else if (row.source === "rejected" && row.rejectedRegex) {
			lines.push(`${contIndent}${t.fg("muted", "model wrote (rejected):")} ${t.fg("warning", row.rejectedRegex)}`);
		} else if (row.source === "unavailable") {
			lines.push(`${contIndent}${t.fg("error", "(no proposal — ollama unreachable)")}`);
		}
	}

	private formatStateBadge(row: LadderRow, index: number): string {
		const t = this.theme;
		const state = this.states[index];
		if (row.source === "existing") return t.fg("success", "● existing rule");
		const variantTag = (state === "always-allow" || state === "always-deny") && row.source === "proposed"
			? ` [v${row.variantIdx + 1}]`
			: "";
		switch (state) {
			case "pending":
				return t.fg("warning", "○ pending");
			case "allow-once":
				return t.fg("success", "● this call only");
			case "deny-once":
				return t.fg("error", "● block this call");
			case "always-allow":
				return t.fg("success", `● session allow${variantTag}`);
			case "always-deny":
				return t.fg("error", `● session deny${variantTag}`);
		}
	}

	private formatRiskBadge(row: LadderRow): string {
		const t = this.theme;
		switch (row.risk) {
			case "low": return t.fg("muted", "[low risk]");
			case "medium": return t.fg("warning", "[medium risk]");
			case "high": return t.fg("error", "[HIGH RISK]");
			case "critical": return t.fg("error", t.bold("[CRITICAL]"));
		}
	}

	private formatPositionLine(row: LadderRow, indent: string, isFocused: boolean): string {
		const t = this.theme;
		const total = row.variants.length;
		const idx = row.variantIdx;
		const dotOn = t.fg("accent", "●");
		const dotOff = t.fg("muted", "○");
		const dots = Array.from({ length: total }, (_, i) => (i === idx ? dotOn : dotOff)).join(" ");
		const left = idx > 0 ? t.fg(isFocused ? "accent" : "muted", "◀") : t.fg("muted", " ");
		const right = idx < total - 1 ? t.fg(isFocused ? "accent" : "muted", "▶") : t.fg("muted", " ");
		const positionTag = t.fg("muted", `(${idx + 1}/${total})`);
		const less = t.fg("muted", "← less specific");
		const more = t.fg("muted", "more specific →");
		return `${indent}${left}  ${dots}  ${right}   ${positionTag}   ${less}   ${more}`;
	}

	private formatSourceTag(row: LadderRow): string {
		const t = this.theme;
		switch (row.source) {
			case "existing":
				return t.fg("muted", "(existing rule)");
			case "proposed":
				return t.fg("muted", "(proposed)");
			case "rejected":
				return t.fg("warning", "(model proposal rejected — only allow once / deny once available)");
			case "unavailable":
				return t.fg("error", "(no proposal — only allow once / deny once available)");
		}
	}

	handleInput(data: string): void {
		if (this.finished) return;

		if (this.mode === "refine-input") return this.handleRefineInput(data);
		if (this.mode === "refine-streaming") return this.handleRefineStreaming(data);

		// Decide mode — any keypress clears a stale flash message.
		this.flashMessage = null;

		if (matchesKey(data, "left")) return this.shiftVariant(-1);
		if (matchesKey(data, "right")) return this.shiftVariant(1);
		if (matchesKey(data, "up") || matchesKey(data, "shift+tab")) return this.shiftFocus(-1);
		if (matchesKey(data, "down") || matchesKey(data, "tab")) return this.shiftFocus(1);
		if (matchesKey(data, "ctrl+a")) return this.setAllPending("always-allow");
		if (matchesKey(data, "ctrl+d")) return this.setAllPending("always-deny");
		if (matchesKey(data, "a")) return this.setFocused("allow-once");
		if (matchesKey(data, "shift+a")) return this.setFocused("always-allow");
		if (matchesKey(data, "d")) return this.setFocused("deny-once");
		if (matchesKey(data, "shift+d")) return this.setFocused("always-deny");
		if (matchesKey(data, "r")) return this.requestRefine();
		if (matchesKey(data, "enter")) return this.trySubmit();
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.finished = true;
			this.done({ action: "cancel" });
			return;
		}
	}

	private requestRefine(): void {
		const rowIdx = this.refinableIdx[this.focusPos];
		if (rowIdx === undefined) {
			this.flashMessage = "No refinable row to edit.";
			return;
		}
		const row = this.rows[rowIdx];
		if (row.risk === "critical") {
			this.flashMessage = "This row is locked — destructive or remote-mutating commands can't be refined.";
			return;
		}
		this.mode = "refine-input";
		this.refineDirective = "";
		this.refineBuffer = "";
		this.refineRowIdx = rowIdx;
		// For rejected/unavailable rows, variants is empty — start at slot 0.
		this.refineVariantIdx = row.variants.length > 0 ? row.variantIdx : 0;
	}

	private handleRefineInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.cancelRefine();
			return;
		}
		if (matchesKey(data, "enter")) {
			const trimmed = this.refineDirective.trim();
			if (!trimmed) {
				this.cancelRefine();
				return;
			}
			void this.startRefineStream(trimmed);
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.refineDirective = this.refineDirective.slice(0, -1);
			return;
		}
		// Printable single character — append.
		if (data.length === 1) {
			const code = data.charCodeAt(0);
			if (code >= 0x20 && code !== 0x7f) {
				this.refineDirective += data;
			}
		}
	}

	private handleRefineStreaming(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.refineAbort?.abort();
			// state cleanup happens in startRefineStream's finally
		}
		// Other keys ignored during streaming.
	}

	private cancelRefine(): void {
		this.mode = "decide";
		this.refineDirective = "";
		this.refineBuffer = "";
		this.refineRowIdx = null;
		this.refineVariantIdx = null;
		this.refineAbort = null;
	}

	private async startRefineStream(directive: string): Promise<void> {
		const rowIdx = this.refineRowIdx;
		const variantIdx = this.refineVariantIdx;
		if (rowIdx === null || variantIdx === null) return;
		const row = this.rows[rowIdx];
		// rejected/unavailable rows have no current variant — pass the
		// rejected regex (if any) as context, else empty. The refineFn's
		// shortcut path doesn't need a current regex; the model fallback
		// gets some signal about what was tried.
		const currentRegex = row.variants[variantIdx]?.regex ?? row.rejectedRegex ?? "";

		this.mode = "refine-streaming";
		this.refineBuffer = "";
		this.refineAbort = new AbortController();
		this.tui.requestRender();

		try {
			const outcome = await this.refineFn(
				row.segmentText,
				currentRegex,
				directive,
				(acc) => {
					this.refineBuffer = acc;
					this.tui.requestRender();
				},
				this.refineAbort.signal,
			);
			if (outcome === null) {
				this.flashMessage = "Model unavailable for refinement.";
			} else if (!outcome.ok) {
				this.flashMessage = `Refinement rejected: ${outcome.reason}`;
			} else {
				row.variants[variantIdx] = outcome.variant;
				// Promote a refined rejected/unavailable row into a normal
				// proposed row so it renders the variant detail.
				if (row.source === "rejected" || row.source === "unavailable") {
					row.source = "proposed";
					row.rejectedRegex = null;
					row.variantIdx = variantIdx;
				}
			}
		} catch (e) {
			this.flashMessage = `Refinement error: ${(e as Error).message ?? String(e)}`;
		} finally {
			this.cancelRefine();
			this.tui.requestRender();
		}
	}

	private renderRefinePanel(lines: string[]): void {
		const t = this.theme;
		const row = this.refineRowIdx !== null ? this.rows[this.refineRowIdx] : null;
		const segLabel = row ? `"${row.segmentText}"` : "";
		if (this.mode === "refine-input") {
			lines.push(`  ${t.bold(t.fg("accent", `refine ${segLabel}:`))}  ${t.fg("muted", "(Enter to run, Esc to cancel)")}`);
			lines.push(`  ${t.fg("accent", "›")} ${this.refineDirective}${t.fg("muted", "▮")}`);
			return;
		}
		// streaming
		lines.push(`  ${t.bold(t.fg("accent", `refine ${segLabel}:`))}  ${t.fg("muted", `(${this.refineDirective}) — Esc aborts`)}`);
		const preview = this.extractStreamingRegex(this.refineBuffer);
		if (preview) {
			lines.push(`  ${t.fg("muted", "regex:")}  ${t.fg("success", preview)}`);
		} else {
			const tail = this.refineBuffer.length > 200 ? this.refineBuffer.slice(-200) : this.refineBuffer;
			lines.push(`  ${t.fg("muted", "model:")}  ${t.fg("muted", tail || "…")}`);
		}
	}

	/** Detail block for the focused row in tabbed mode — leaner than renderRow. */
	private renderRowTabbed(lines: string[], row: LadderRow, index: number): void {
		const t = this.theme;
		const risk = this.formatRiskBadge(row);
		const stateBadge = this.formatStateBadge(row, index);
		lines.push(`  ${t.bold(t.fg("accent", "segment:"))} ${row.display.split("\n")[0]}   ${risk}`);
		const tailLines = row.display.split("\n").slice(1);
		for (const tl of tailLines) lines.push(`            ${tl}`);

		if (row.source === "proposed" && row.variants.length > 0) {
			const allEqual = row.variants.every((v) => v.regex === row.variants[0].regex);
			const hardLocked = row.risk === "critical";
			if (!allEqual) {
				lines.push(this.formatPositionLine(row, "  ", true));
			} else if (hardLocked) {
				lines.push(`  ${t.fg("warning", "(locked: generalization not safe for this command)")}`);
			} else {
				lines.push(`  ${t.fg("warning", "(only one viable variant — press [r] to refine)")}`);
			}
			const v = row.variants[row.variantIdx];
			if (v) lines.push(`  ${t.fg("muted", "regex:")}  ${t.fg("success", v.regex)}`);
		} else if (row.source === "existing" && row.existingRegex) {
			lines.push(`  ${t.fg("muted", "regex:")}  ${t.fg("success", row.existingRegex)}  ${t.fg("muted", "(existing rule)")}`);
		} else if (row.source === "rejected" && row.rejectedRegex) {
			lines.push(`  ${t.fg("muted", "model wrote (rejected):")} ${t.fg("warning", row.rejectedRegex)}`);
		} else if (row.source === "unavailable") {
			lines.push(`  ${t.fg("error", "(no proposal — ollama unreachable)")}`);
		}
		lines.push(`  ${t.fg("muted", "state:")}  ${stateBadge}`);
	}

	/** Vertical tab list — one per line, focused row marked, state icon per row. */
	private renderTabStrip(lines: string[], width: number): void {
		const t = this.theme;
		const focusedIdx = this.refinableIdx[this.focusPos];
		this.rows.forEach((row, i) => {
			const line = this.formatTabCell(row, i, i === focusedIdx);
			lines.push(visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line);
		});
		const pending = this.pendingCount();
		const summary = pending > 0
			? t.fg("warning", `${pending} pending`)
			: t.fg("success", "ready to submit");
		lines.push(`  ${t.fg("muted", `${this.rows.length} segment${this.rows.length === 1 ? "" : "s"}`)}   ${summary}`);
	}

	private formatTabCell(row: LadderRow, index: number, isFocused: boolean): string {
		const t = this.theme;
		const state = this.states[index];
		const icon = this.tabStateIcon(row, state);
		const labelRaw = row.segmentText.split("\n")[0];
		const num = `[${index + 1}]`;
		const prefix = isFocused ? t.bold(t.fg("accent", "›")) : " ";
		const body = `${num} ${labelRaw}`;
		const styledBody = isFocused
			? t.bold(t.fg("accent", body))
			: row.source === "existing"
				? t.fg("muted", body)
				: body;
		return ` ${prefix} ${styledBody} ${icon}`;
	}

	private tabStateIcon(row: LadderRow, state: RowState): string {
		const t = this.theme;
		if (row.source === "existing") return t.fg("success", "✓");
		switch (state) {
			case "pending": return t.fg("warning", "○");
			case "allow-once": return t.fg("success", "●");
			case "deny-once": return t.fg("error", "●");
			case "always-allow": return t.fg("success", "●");
			case "always-deny": return t.fg("error", "●");
		}
	}

	/** Pull a partial regex out of the streaming buffer, for live preview. */
	private extractStreamingRegex(buf: string): string | null {
		const open = buf.indexOf("<regex>");
		if (open < 0) return null;
		const after = buf.slice(open + "<regex>".length);
		const close = after.indexOf("</regex>");
		return close >= 0 ? after.slice(0, close).trim() : after.trim();
	}

	private shiftVariant(delta: number): void {
		const rowIdx = this.refinableIdx[this.focusPos];
		if (rowIdx === undefined) return;
		const row = this.rows[rowIdx];
		if (row.source !== "proposed") return;
		const next = row.variantIdx + delta;
		if (next < 0 || next >= row.variants.length) return;
		row.variantIdx = next;
	}

	private shiftFocus(delta: number): void {
		if (this.refinableIdx.length === 0) return;
		const next = this.focusPos + delta;
		if (next < 0 || next >= this.refinableIdx.length) return;
		this.focusPos = next;
	}

	private setFocused(state: RowState): void {
		const rowIdx = this.refinableIdx[this.focusPos];
		if (rowIdx === undefined) return;
		this.states[rowIdx] = this.normalizeState(this.rows[rowIdx], state);
		// Single-segment fast path: skip the pending+Enter dance.
		if (this.refinableIdx.length === 1) this.trySubmit();
	}

	private setAllPending(state: RowState): void {
		for (const i of this.refinableIdx) {
			if (this.states[i] === "pending") {
				this.states[i] = this.normalizeState(this.rows[i], state);
			}
		}
		// Same single-segment fast path for ctrl+a / ctrl+d.
		if (this.refinableIdx.length === 1) this.trySubmit();
	}

	/** rejected/unavailable rows can't get a rule — coerce always-* to once-*. */
	private normalizeState(row: LadderRow, state: RowState): RowState {
		if (row.source === "proposed" && row.variants.length > 0) return state;
		if (state === "always-allow") return "allow-once";
		if (state === "always-deny") return "deny-once";
		return state;
	}

	private pendingCount(): number {
		let n = 0;
		for (const i of this.refinableIdx) {
			if (this.states[i] === "pending") n++;
		}
		return n;
	}

	private trySubmit(): void {
		const pending = this.pendingCount();
		if (pending > 0) {
			this.flashMessage = `${pending} row${pending === 1 ? "" : "s"} pending — decide every row before submitting (or Esc to cancel).`;
			return;
		}
		this.finished = true;
		const decisions: RowDecision[] = this.rows.map((row, i) => {
			if (row.source === "existing") return { kind: "existing" };
			const state = this.states[i];
			const variant = row.source === "proposed" && row.variants.length > 0
				? row.variants[row.variantIdx]
				: null;
			switch (state) {
				case "allow-once": return { kind: "allow-once" };
				case "deny-once": return { kind: "deny-once" };
				case "always-allow": return { kind: "always-allow", variant };
				case "always-deny": return { kind: "always-deny", variant };
				case "pending": return { kind: "deny-once" }; // unreachable; guarded above
			}
		});
		this.done({ action: "submit", decisions });
	}
}
