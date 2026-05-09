import type { Rule } from "./csp.js";

export interface IpcInit {
	type: "init";
	templates: Array<{ name?: string; rules: Rule[] }>;
}

export interface IpcDecideRequest {
	id: string;
	type: "decide";
	action: string;
}

/**
 * Fire-and-forget message from proxy to extension recording a request that
 * the proxy handled itself (allow via existing permit, forbid via rule, or
 * default-deny when no IPC is available). The extension uses it to populate
 * per-toolCallId metadata so the bash result card can show what fired.
 */
export interface IpcAudit {
	type: "audit";
	action: string;
	decision: "allow" | "deny";
	matchedPattern?: string;
	matchedPolicy?: string;
	matchedEffect?: "permit" | "forbid";
}

export type IpcServerMessage = IpcInit | IpcDecideRequest | IpcAudit;

export interface IpcDecisionResponse {
	id: string;
	type: "decision";
	decision: "allow" | "deny";
	attribution: string;
	addRule?: { effect: "permit" | "forbid"; pattern: string };
}

export interface IpcAddRule {
	type: "addRule";
	effect: "permit" | "forbid";
	pattern: string;
}

export type IpcClientMessage = IpcDecisionResponse | IpcAddRule;

// Backwards-compat aliases used by older code
export type IpcRequest = IpcDecideRequest;
export type IpcResponse = IpcDecisionResponse;
