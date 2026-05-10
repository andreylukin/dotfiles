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
			if (!enforce) return {};
			const url = new URL(req.url);
			const action = netAction(req.method, url.hostname, url.pathname + url.search);
			const result = evaluate(action, policies);

			if (result.decision === "deny" && result.matchedRule?.effect === "forbid") {
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
				ipc?.audit({
					action,
					decision: "allow",
					matchedPattern: result.matchedRule?.pattern,
					matchedPolicy: result.matchedPolicy,
					matchedEffect: "permit",
				});
				return {};
			}
			if (!ipc) return forbidResponse("default deny");

			try {
				const reply = await ipc.query({ action });
				if (reply.addRule) {
					sessionPolicy.rules.push({
						effect: reply.addRule.effect,
						pattern: reply.addRule.pattern,
					});
				}
				if (reply.decision === "allow") return {};
				return forbidResponse("user denied");
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
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

