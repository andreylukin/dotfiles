import * as net from "node:net";
import type {
	IpcAddRule,
	IpcAudit,
	IpcDecideRequest,
	IpcDecisionResponse,
	IpcInit,
	IpcServerMessage,
} from "@permissions/shared";

export type DecisionHandler = (
	req: IpcDecideRequest,
) => Promise<Omit<IpcDecisionResponse, "id" | "type">>;

export type InitHandler = (msg: IpcInit) => void;
export type AuditHandler = (msg: IpcAudit) => void;

export interface IpcClient {
	addRule: (rule: Omit<IpcAddRule, "type">) => void;
	close: () => void;
}

export function connectIpc(
	socketPath: string,
	handlers: { onDecide: DecisionHandler; onInit: InitHandler; onAudit?: AuditHandler },
): Promise<IpcClient> {
	return new Promise((resolve, reject) => {
		const conn = net.createConnection(socketPath);
		conn.setEncoding("utf8");
		let buffer = "";

		conn.on("data", async (chunk: string) => {
			buffer += chunk;
			let idx: number;
			while ((idx = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 1);
				if (!line) continue;
				let msg: IpcServerMessage;
				try {
					msg = JSON.parse(line);
				} catch {
					continue;
				}
				if (msg.type === "init") {
					handlers.onInit(msg);
				} else if (msg.type === "decide") {
					const reply = await handlers.onDecide(msg);
					const out: IpcDecisionResponse = {
						id: msg.id,
						type: "decision",
						...reply,
					};
					conn.write(`${JSON.stringify(out)}\n`);
				} else if (msg.type === "audit") {
					handlers.onAudit?.(msg);
				}
			}
		});

		conn.once("connect", () => {
			resolve({
				addRule: (rule) => {
					const msg: IpcAddRule = { type: "addRule", ...rule };
					conn.write(`${JSON.stringify(msg)}\n`);
				},
				close: () => conn.destroy(),
			});
		});
		conn.once("error", reject);
	});
}
