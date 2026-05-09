import { promises as fs } from "node:fs";
import * as mockttp from "mockttp";
import { evaluate, netAction, parsePolicy, type Policy } from "@permissions/shared";
import { ensureCa } from "./ca.js";
import { startIpcServer } from "./ipc-server.js";

const PROXY_PORT = 8443;

export interface ProxyOptions {
	policyPath?: string;
	templatePaths?: string[];
	withIpc?: boolean;
}

export interface ProxyHandle {
	port: number;
	sessionPolicy: Policy;
	templates: Policy[];
	socketPath?: string;
	stop: () => Promise<void>;
}

export async function startProxy(opts: ProxyOptions = {}): Promise<ProxyHandle> {
	const ca = await ensureCa();
	const templates: Policy[] = [];
	if (opts.policyPath) {
		templates.push(parsePolicy(await fs.readFile(opts.policyPath, "utf8")));
	}
	for (const tp of opts.templatePaths ?? []) {
		templates.push(parsePolicy(await fs.readFile(tp, "utf8")));
	}
	const sessionPolicy: Policy = { name: "session", rules: [] };
	const policies: Policy[] = [...templates, sessionPolicy];

	const ipc = opts.withIpc
		? await startIpcServer({
				templates: templates.map((p) => ({ name: p.name, rules: p.rules })),
				onAddRule: (r) => sessionPolicy.rules.push({ effect: r.effect, pattern: r.pattern }),
			})
		: undefined;
	const enforce = templates.length > 0 || ipc !== undefined;

	const server = mockttp.getLocal({ https: { cert: ca.cert, key: ca.key } });

	await server.forAnyRequest().thenPassThrough({
		beforeRequest: async (req) => {
			const ts = new Date().toISOString();
			if (!enforce) {
				console.log(`${ts} ${req.method} ${req.url} → no-enforce`);
				return {};
			}
			const url = new URL(req.url);
			const action = netAction(req.method, url.hostname, url.pathname + url.search);
			const result = evaluate(action, policies);

			if (result.decision === "deny" && result.matchedRule?.effect === "forbid") {
				const tag = formatAuditTag({
					decision: "deny",
					source: "rule",
					matchedPattern: result.matchedRule.pattern,
					matchedPolicy: result.matchedPolicy,
					matchedEffect: "forbid",
				});
				console.log(`${ts} ${req.method} ${req.url} → ${tag}`);
				ipc?.audit({
					action,
					decision: "deny",
					matchedPattern: result.matchedRule.pattern,
					matchedPolicy: result.matchedPolicy,
					matchedEffect: "forbid",
				});
				return forbidResponse(result.reason);
			}
			if (result.decision === "allow") {
				const tag = formatAuditTag({
					decision: "allow",
					source: "rule",
					matchedPattern: result.matchedRule?.pattern,
					matchedPolicy: result.matchedPolicy,
					matchedEffect: "permit",
				});
				console.log(`${ts} ${req.method} ${req.url} → ${tag}`);
				ipc?.audit({
					action,
					decision: "allow",
					matchedPattern: result.matchedRule?.pattern,
					matchedPolicy: result.matchedPolicy,
					matchedEffect: "permit",
				});
				return {};
			}
			if (!ipc) {
				console.log(`${ts} ${req.method} ${req.url} → deny [default-deny: no ipc connected]`);
				return forbidResponse("default deny");
			}

			try {
				const reply = await ipc.query({ action });
				if (reply.addRule) {
					sessionPolicy.rules.push({
						effect: reply.addRule.effect,
						pattern: reply.addRule.pattern,
					});
				}
				const tag = formatUserDecisionTag(reply);
				console.log(`${ts} ${req.method} ${req.url} → ${tag}`);
				if (reply.decision === "allow") return {};
				return forbidResponse("user denied");
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.log(`${ts} ${req.method} ${req.url} → deny [ipc-error: ${msg}]`);
				return forbidResponse(`extension error: ${msg}`);
			}
		},
	});

	await server.start(PROXY_PORT);
	const tplNames = templates.map((t) => t.name ?? "(unnamed)").join(",");
	console.log(
		`proxy listening on 127.0.0.1:${PROXY_PORT}${tplNames ? ` templates=${tplNames}` : ""}${ipc ? ` ipc=${ipc.socketPath}` : ""}`,
	);

	return {
		port: PROXY_PORT,
		sessionPolicy,
		templates,
		socketPath: ipc?.socketPath,
		stop: async () => {
			if (ipc) await ipc.close();
			await server.stop();
		},
	};
}

function forbidResponse(reason: string) {
	return {
		response: {
			statusCode: 403,
			headers: { "content-type": "text/plain" },
			body: `permissions: ${reason}\n`,
		},
	};
}

interface AuditTagFields {
	decision: "allow" | "deny";
	source: "rule";
	matchedPattern?: string;
	matchedPolicy?: string;
	matchedEffect?: "permit" | "forbid";
}

/** Renders a structured log tag for proxy decisions made without prompting the user. */
function formatAuditTag(f: AuditTagFields): string {
	const policy = f.matchedPolicy ? `policy=${f.matchedPolicy}` : "policy=(unnamed)";
	const pattern = f.matchedPattern ? `match=${f.matchedPattern}` : "match=(unknown)";
	const effect = f.matchedEffect ? `effect=${f.matchedEffect}` : "";
	const parts = [f.decision, `[rule]`, policy, pattern, effect].filter(Boolean);
	return parts.join(" ");
}

interface UserDecisionTagFields {
	decision: "allow" | "deny";
	attribution: string;
	addRule?: { effect: "permit" | "forbid"; pattern: string };
}

/** Renders a structured log tag for proxy decisions made via user prompt. */
function formatUserDecisionTag(f: UserDecisionTagFields): string {
	const attribution = `attribution=${f.attribution}`;
	const ruleAdded = f.addRule
		? `+${f.addRule.effect}=${f.addRule.pattern}`
		: "rule-added=none";
	return [f.decision, "[user]", attribution, ruleAdded].join(" ");
}
