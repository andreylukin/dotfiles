import type {
	BashToolCallEvent,
	ExtensionAPI,
} from "@mariozechner/pi-coding-agent";

interface ActiveCall {
	toolCallId: string;
	toolName: string;
	bashCommand?: string;
}

const active: ActiveCall[] = [];

export function attachAttributionTracking(pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => {
		const entry: ActiveCall = {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
		};
		if (event.toolName === "bash") {
			entry.bashCommand = (event as BashToolCallEvent).input.command;
		}
		active.push(entry);
	});

	pi.on("tool_result", (event) => {
		const idx = active.findIndex((c) => c.toolCallId === event.toolCallId);
		if (idx >= 0) active.splice(idx, 1);
	});
}

export function currentAttribution(): string {
	if (active.length === 0) return "extension:background";
	const last = active[active.length - 1];
	if (last.toolName === "bash" && last.bashCommand) {
		const cmd =
			last.bashCommand.length > 60
				? `${last.bashCommand.slice(0, 60)}…`
				: last.bashCommand;
		return `tool:bash (${cmd})`;
	}
	return `tool:${last.toolName}`;
}

/** toolCallId of the active bash invocation (top of stack), or undefined if none. */
export function currentBashToolCallId(): string | undefined {
	for (let i = active.length - 1; i >= 0; i--) {
		if (active[i].toolName === "bash") return active[i].toolCallId;
	}
	return undefined;
}
