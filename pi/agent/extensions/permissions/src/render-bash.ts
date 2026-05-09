import { Container, Text } from "@mariozechner/pi-tui";
import type { NetMeta, SegmentMeta, Source, ToolCallMeta } from "./metadata.js";

const PREVIEW_LINES = 5;
const MAX_GROUPS = 10;

interface BashCallArgs {
	command?: string;
	timeout?: number;
}

/** Subset of pi's Theme used here. Avoids depending on the internal type. */
export interface RenderTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface RenderInputs {
	args: BashCallArgs;
	textOutput: string;
	isError: boolean;
	isPartial: boolean;
	expanded: boolean;
	startedAt?: number;
	endedAt?: number;
	meta: ToolCallMeta | undefined;
	theme: RenderTheme;
}

/**
 * Renders the bash result card: command line, output preview, took, then a
 * compact `permissions:` block summarizing what fired during this tool call.
 *
 * Uses pi's theme.fg/theme.bold so colors compose correctly with pi-tui's
 * per-line bg-fn wrapping (which would terminate raw ANSI resets mid-line
 * and wash the colors out).
 */
export function renderBashResult(
	container: Container,
	inputs: RenderInputs,
): void {
	container.clear();

	container.addChild(new Text(formatCommandLine(inputs), 0, 0));

	const outputBlock = formatOutput(inputs);
	if (outputBlock) container.addChild(new Text(outputBlock, 0, 0));

	const tookLine = formatTookLine(inputs);
	if (tookLine) container.addChild(new Text(tookLine, 0, 0));

	if (inputs.meta && !inputs.isPartial) {
		const block = formatPermissionsBlock(inputs.meta, inputs.theme);
		if (block) container.addChild(new Text(block, 0, 0));
	}
}

function formatCommandLine(inputs: RenderInputs): string {
	const { theme } = inputs;
	const command = typeof inputs.args.command === "string" ? inputs.args.command : "";
	const display = command.length > 0 ? command : "...";
	const timeoutSuffix = inputs.args.timeout
		? theme.fg("muted", ` (timeout ${inputs.args.timeout}s)`)
		: "";
	return `${theme.fg("toolTitle", theme.bold("$"))} ${theme.fg("accent", display)}${timeoutSuffix}`;
}

function formatOutput(inputs: RenderInputs): string {
	const { theme } = inputs;
	const out = inputs.textOutput.trim();
	if (!out) {
		if (inputs.isPartial) return theme.fg("muted", "(no output yet)");
		return theme.fg("muted", "(no output)");
	}
	const lines = out.split("\n");
	if (inputs.expanded || lines.length <= PREVIEW_LINES) {
		return colorOutput(lines, inputs.isError, theme).join("\n");
	}
	const skipped = lines.length - PREVIEW_LINES;
	const tail = lines.slice(-PREVIEW_LINES);
	const hint = theme.fg("muted", `... (${skipped} earlier lines, expand to see all)`);
	return [hint, ...colorOutput(tail, inputs.isError, theme)].join("\n");
}

function colorOutput(lines: string[], isError: boolean, theme: RenderTheme): string[] {
	const color = isError ? "error" : "toolOutput";
	return lines.map((l) => theme.fg(color, l));
}

function formatTookLine(inputs: RenderInputs): string | null {
	if (inputs.startedAt === undefined) return null;
	const end = inputs.endedAt ?? Date.now();
	const elapsed = end - inputs.startedAt;
	const label = inputs.isPartial ? "Elapsed" : "Took";
	return inputs.theme.fg("muted", `${label} ${formatDuration(elapsed)}`);
}

function formatDuration(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	if (m < 60) return `${m}m ${rem}s`;
	const h = Math.floor(m / 60);
	return `${h}h ${m % 60}m`;
}

interface BashGroup {
	regex: string;
	source: Source;
	policy: string | null;
	count: number;
}

interface NetGroup {
	glob: string | null;
	source: Source;
	policy: string | null;
	count: number;
	exemplar: string;
	hosts: Set<string>;
}

function formatPermissionsBlock(meta: ToolCallMeta, theme: RenderTheme): string {
	const bashGroups = groupBash(meta.bashSegments);
	const netGroups = groupNet(meta.netActions);

	if (bashGroups.length === 0 && netGroups.length === 0) {
		return "";
	}

	const lines: string[] = [];
	lines.push(theme.fg("dim", theme.bold("permissions:")));

	const bashShown = bashGroups.slice(0, MAX_GROUPS);
	for (const g of bashShown) {
		lines.push(formatBashGroup(g, theme));
	}
	if (bashGroups.length > bashShown.length) {
		lines.push(
			"  " + theme.fg("muted", `… ${bashGroups.length - bashShown.length} more bash group(s)`),
		);
	}

	const netShown = netGroups.slice(0, MAX_GROUPS);
	for (const g of netShown) {
		lines.push(formatNetGroup(g, theme));
	}
	if (netGroups.length > netShown.length) {
		lines.push(
			"  " + theme.fg("muted", `… ${netGroups.length - netShown.length} more net group(s)`),
		);
	}

	return lines.join("\n");
}

function groupBash(segs: SegmentMeta[]): BashGroup[] {
	const map = new Map<string, BashGroup>();
	for (const s of segs) {
		const key = `${s.regex ?? "(none)"}|${s.source}|${s.policy ?? ""}`;
		const existing = map.get(key);
		if (existing) {
			existing.count++;
		} else {
			map.set(key, {
				regex: s.regex ?? "(no regex)",
				source: s.source,
				policy: s.policy,
				count: 1,
			});
		}
	}
	return Array.from(map.values());
}

function groupNet(actions: NetMeta[]): NetGroup[] {
	const map = new Map<string, NetGroup>();
	for (const a of actions) {
		const key = `${a.glob ?? "(none)"}|${a.source}|${a.policy ?? ""}`;
		const host = extractHost(a.action);
		const existing = map.get(key);
		if (existing) {
			existing.count++;
			if (host) existing.hosts.add(host);
		} else {
			map.set(key, {
				glob: a.glob,
				source: a.source,
				policy: a.policy,
				count: 1,
				exemplar: a.action,
				hosts: new Set(host ? [host] : []),
			});
		}
	}
	return Array.from(map.values());
}

function formatBashGroup(g: BashGroup, theme: RenderTheme): string {
	const icon = sourceIcon(g.source, theme);
	const policyTag = g.policy ? theme.fg("muted", g.policy) : theme.fg("muted", "(no rule)");
	const sourceTag = sourceLabel(g.source, theme);
	const countTag = g.count > 1 ? " " + theme.fg("muted", `(×${g.count})`) : "";
	const arrow = theme.fg("muted", "→");
	const regexFmt = sourceColored(g.source, g.regex, theme);
	return `  bash ${icon} ${regexFmt}  ${arrow}  ${policyTag} ${sourceTag}${countTag}`;
}

function formatNetGroup(g: NetGroup, theme: RenderTheme): string {
	const icon = sourceIcon(g.source, theme);
	const policyTag = g.policy ? theme.fg("muted", g.policy) : theme.fg("muted", "(no rule)");
	const sourceTag = sourceLabel(g.source, theme);
	const target = g.glob ?? g.exemplar;
	const countTag =
		g.count > 1
			? " " +
				theme.fg(
					"muted",
					g.hosts.size > 1
						? `(${g.count} requests, ${g.hosts.size} hosts)`
						: `(${g.count} requests)`,
				)
			: "";
	const arrow = theme.fg("muted", "→");
	const targetFmt = sourceColored(g.source, target, theme);
	return `  net  ${icon} ${targetFmt}  ${arrow}  ${policyTag} ${sourceTag}${countTag}`;
}

function sourceIcon(source: Source, theme: RenderTheme): string {
	switch (source) {
		case "existing":
		case "added":
		case "once-allow":
			return theme.fg("success", "✓");
		case "denied":
		case "once-deny":
			return theme.fg("error", "✗");
		case "default-deny":
			return theme.fg("warning", "⚠");
	}
}

function sourceColored(source: Source, text: string, theme: RenderTheme): string {
	switch (source) {
		case "existing":
		case "added":
		case "once-allow":
			return theme.fg("success", text);
		case "denied":
		case "once-deny":
			return theme.fg("error", text);
		case "default-deny":
			return theme.fg("warning", text);
	}
}

function sourceLabel(source: Source, theme: RenderTheme): string {
	switch (source) {
		case "existing":
			return theme.fg("muted", "[existing]");
		case "added":
			return theme.fg("success", "[just added]");
		case "once-allow":
			return theme.fg("muted", "[once]");
		case "once-deny":
			return theme.fg("error", "[once-deny]");
		case "denied":
			return theme.fg("error", "[denied]");
		case "default-deny":
			return theme.fg("warning", "[default-deny]");
	}
}

function extractHost(action: string): string | null {
	if (!action.startsWith("net:")) return null;
	const rest = action.split(":").slice(2).join(":");
	const slash = rest.indexOf("/");
	return slash === -1 ? rest : rest.slice(0, slash);
}
