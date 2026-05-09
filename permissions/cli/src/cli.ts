#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { Command } from "commander";
import { ensureCa } from "./ca.js";
import { spawnPi } from "./child.js";
import { startProxy } from "./proxy.js";
import { seatbeltProfile } from "./seatbelt.js";
import { resolveTemplatePath } from "./templates.js";
import { trustCa } from "./trust-cert.js";

const program = new Command();
program.name("permissions").description("Permissions launcher").enablePositionalOptions();

program
	.command("proxy")
	.description("Start standalone MITM proxy on 127.0.0.1:8443 (no IPC, no pi)")
	.option("--policy <path>", "load a .csp policy file")
	.action(async (opts: { policy?: string }) => {
		await startProxy({ policyPath: opts.policy });
	});

const collect = (value: string, prev: string[]): string[] => [...prev, value];

program
	.command("pi")
	.description("Run pi inside Seatbelt sandbox with proxy + IPC")
	.option("--policy <path>", "load a .csp policy file (raw path)")
	.option("--template <name>", "load a named template (~/.permissions/templates or bundled)", collect, [])
	.argument("[pi-args...]", "args forwarded to pi (use -- to separate flags)")
	.passThroughOptions()
	.action(async (piArgs: string[], opts: { policy?: string; template: string[] }) => {
		const templatePaths: string[] = [];
		for (const name of opts.template) {
			templatePaths.push(await resolveTemplatePath(name));
		}

		const ca = await ensureCa();
		const trust = await trustCa(ca.certPath);
		if (trust.ok && !trust.skipped) {
			console.log("[permissions] CA added to user trust (Go binaries can now reach https through the proxy)");
		} else if (!trust.ok) {
			console.warn(`[permissions] CA not auto-trusted: ${trust.reason}`);
			console.warn("[permissions] Go binaries (restish, gh, etc.) will fail TLS until trusted manually.");
		}

		const proxy = await startProxy({
			policyPath: opts.policy,
			templatePaths,
			withIpc: true,
		});
		if (!proxy.socketPath) throw new Error("ipc socket missing");

		const profilePath = `/tmp/permissions-${process.pid}.sb`;
		await fs.writeFile(profilePath, seatbeltProfile(proxy.socketPath));

		const child = spawnPi({
			args: piArgs,
			socketPath: proxy.socketPath,
			caPath: ca.certPath,
			bundlePath: ca.bundlePath,
			proxyUrl: `http://127.0.0.1:${proxy.port}`,
			profilePath,
		});

		for (const sig of ["SIGINT", "SIGTERM"] as const) {
			process.on(sig, () => child.kill(sig));
		}
		child.on("exit", async (code) => {
			await fs.unlink(profilePath).catch(() => {});
			await proxy.stop();
			process.exit(code ?? 0);
		});
	});

await program.parseAsync(process.argv);
