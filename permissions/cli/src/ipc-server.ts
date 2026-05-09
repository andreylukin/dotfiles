import { promises as fs } from "node:fs";
import * as net from "node:net";
import type {
	IpcAddRule,
	IpcAudit,
	IpcDecideRequest,
	IpcDecisionResponse,
	IpcInit,
	IpcServerMessage,
} from "@permissions/shared";

export interface IpcServerOptions {
	templates: IpcInit["templates"];
	onAddRule: (rule: IpcAddRule) => void;
}

export interface IpcServer {
	socketPath: string;
	query: (args: { action: string }) => Promise<IpcDecisionResponse>;
	audit: (msg: Omit<IpcAudit, "type">) => void;
	close: () => Promise<void>;
}

export async function startIpcServer(opts: IpcServerOptions): Promise<IpcServer> {
	const socketPath = `/tmp/permissions-${process.pid}.sock`;
	await fs.unlink(socketPath).catch(() => {});

	let activeSocket: net.Socket | null = null;
	const connectWaiters: ((s: net.Socket) => void)[] = [];
	const pending = new Map<string, (r: IpcDecisionResponse) => void>();
	let nextId = 0;

	const send = (sock: net.Socket, msg: IpcServerMessage) => {
		sock.write(`${JSON.stringify(msg)}\n`);
	};

	const server = net.createServer((conn) => {
		activeSocket = conn;
		conn.setEncoding("utf8");
		const initMsg: IpcInit = { type: "init", templates: opts.templates };
		send(conn, initMsg);

		while (connectWaiters.length > 0) {
			const fn = connectWaiters.shift();
			fn?.(conn);
		}

		let buffer = "";
		conn.on("data", (chunk: string) => {
			buffer += chunk;
			let idx: number;
			while ((idx = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 1);
				if (!line) continue;
				try {
					const msg = JSON.parse(line) as IpcDecisionResponse | IpcAddRule;
					if (msg.type === "decision") {
						const cb = pending.get(msg.id);
						if (cb) {
							pending.delete(msg.id);
							cb(msg);
						}
					} else if (msg.type === "addRule") {
						opts.onAddRule(msg);
					}
				} catch {
					// ignore unparseable lines
				}
			}
		});
		conn.on("close", () => {
			if (activeSocket === conn) activeSocket = null;
		});
	});

	await new Promise<void>((res, rej) => {
		server.once("error", rej);
		server.listen(socketPath, () => {
			server.off("error", rej);
			res();
		});
	});

	const getSocket = (): Promise<net.Socket> =>
		activeSocket
			? Promise.resolve(activeSocket)
			: new Promise((res) => connectWaiters.push(res));

	return {
		socketPath,
		query: async ({ action }) => {
			const sock = await getSocket();
			const id = String(nextId++);
			const msg: IpcDecideRequest = { id, type: "decide", action };
			return new Promise<IpcDecisionResponse>((res) => {
				pending.set(id, res);
				send(sock, msg);
			});
		},
		audit: (msg) => {
			// Fire-and-forget. Drops the audit if no client is connected
			// (extension hasn't started yet) — those events aren't observable
			// from a bash card anyway, so it's fine.
			if (!activeSocket) return;
			const out: IpcAudit = { type: "audit", ...msg };
			send(activeSocket, out);
		},
		close: async () => {
			activeSocket?.destroy();
			await new Promise<void>((res) => server.close(() => res()));
			await fs.unlink(socketPath).catch(() => {});
		},
	};
}
