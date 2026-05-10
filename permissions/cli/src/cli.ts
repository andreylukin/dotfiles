#!/usr/bin/env node
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { Command } from "commander";
import { ensureCa } from "./ca.js";
import { spawnPi } from "./child.js";
import { startProxy } from "./proxy.js";
import { seatbeltProfile } from "./seatbelt.js";
import { bundledTemplatesDir, resolveTemplatePath } from "./templates.js";
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
	.option("--no-defaults", "skip auto-loading the bundled bash-trivial template")
	.argument("[pi-args...]", "args forwarded to pi (use -- to separate flags)")
	.passThroughOptions()
	.action(async (piArgs: string[], opts: { policy?: string; template: string[]; defaults: boolean }) => {
		const templatePaths: string[] = [];
		// Auto-load defaults so common operations don't prompt on first use.
		//   - bash-trivial: read-only verbs (ls, cat, git status, …) and
		//     strongly-clamped script capability sets.
		//   - pi-base: GET-only access to public package registries that
		//     pi-mono (self-update) and the pi-lens extension hit on startup.
		// Opt out with --no-defaults.
		if (opts.defaults !== false) {
			templatePaths.push(await resolveTemplatePath("bash-trivial"));
			templatePaths.push(await resolveTemplatePath("pi-base"));
		}
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
		await fs.writeFile(profilePath, seatbeltProfile(proxy.socketPath, { cwd: process.cwd() }));

		const child = spawnPi({
			args: piArgs,
			socketPath: proxy.socketPath,
			caPath: ca.certPath,
			bundlePath: ca.bundlePath,
			proxyUrl: `http://127.0.0.1:${proxy.port}`,
			profilePath,
			bundledTemplatesDir: bundledTemplatesDir(),
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

// Surface macOS Seatbelt denials. The kernel logs every sandbox deny to the
// unified log subsystem; we just filter the stream. Useful when something
// inside pi (or a child of pi) hits an unexpected deny in the outer profile
// and we need to know which path/operation to add to the allowlist.
program
	.command("audit")
	.description("Show macOS sandbox denials (file/network/etc.)")
	.option("--since <duration>", "log show --last value (e.g. 10m, 1h)", "10m")
	.option("--follow", "stream live instead of a one-shot snapshot")
	.action((opts: { since: string; follow?: boolean }) => {
		const predicate = 'sender == "Sandbox" && eventMessage CONTAINS "deny"';
		const args = opts.follow
			? ["stream", "--predicate", predicate]
			: ["show", "--last", opts.since, "--predicate", predicate];
		const child = spawn("log", args, { stdio: "inherit" });
		child.on("exit", (code) => process.exit(code ?? 0));
	});

await program.parseAsync(process.argv);
