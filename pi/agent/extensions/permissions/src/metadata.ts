// Per-toolCallId permissions metadata. Populated at gate time (bash regex,
// bash AST pre-prompt, proxy hold), drained on tool_result, and read by
// the bash renderResult to surface what was decided.

export type Effect = "permit" | "forbid";

export type Source =
	| "existing"        // already covered by a rule (template or session)
	| "added"           // newly persisted via Always allow / Always deny
	| "once-allow"      // Allow once — nothing persisted
	| "once-deny"       // Deny once — nothing persisted
	| "denied"          // forbid rule blocked it (no prompt)
	| "default-deny";   // no rule matched, default deny took over

export interface SegmentMeta {
	segment: string;
	source: Source;
	regex: string | null;   // null for once-* and default-deny
	policy: string | null;  // template name | "session" | null
	effect: Effect | null;
}

export interface NetMeta {
	action: string;
	source: Source;
	glob: string | null;
	policy: string | null;
	effect: Effect | null;
}

export interface ToolCallMeta {
	bashSegments: SegmentMeta[];
	netActions: NetMeta[];
}

const store = new Map<string, ToolCallMeta>();

export function getOrCreateMeta(toolCallId: string): ToolCallMeta {
	let m = store.get(toolCallId);
	if (!m) {
		m = { bashSegments: [], netActions: [] };
		store.set(toolCallId, m);
	}
	return m;
}

export function getMeta(toolCallId: string): ToolCallMeta | undefined {
	return store.get(toolCallId);
}

export function dropMeta(toolCallId: string): void {
	store.delete(toolCallId);
}
