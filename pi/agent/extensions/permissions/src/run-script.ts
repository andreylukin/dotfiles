import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FsCapability = "read-only" | "rw-tmp" | "rw-cwd";
export type NetCapability = "none" | "proxy";
export type ScriptLanguage = "python" | "node" | "bash";

export interface ScriptCapabilities {
	fs: FsCapability;
	net: NetCapability;
}

export interface RunScriptInput {
	language: ScriptLanguage;
	source: string;
	args?: string[];
	stdin?: string;
	capabilities: ScriptCapabilities;
}

export interface RunScriptOptions {
	cwd: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface RunScriptResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
	scratchDir: string;
}

const INTERPRETER: Record<ScriptLanguage, string> = {
	python: "python3",
	node: "node",
	bash: "bash",
};

const EXTENSION: Record<ScriptLanguage, string> = {
	python: "py",
	node: "mjs",
	bash: "sh",
};

export function capabilityActionString(language: ScriptLanguage, caps: ScriptCapabilities): string {
	return `script:lang=${language}:fs=${caps.fs}:net=${caps.net}`;
}

export async function runScript(
	input: RunScriptInput,
	opts: RunScriptOptions,
): Promise<RunScriptResult> {
	// macOS blocks nested `sandbox_apply` from inside an already-sandboxed
	// process (EPERM regardless of outer profile shape), so we don't try to
	// spawn `sandbox-exec` here. The outer pi profile is the FS/net clamp:
	// it denies file-writes outside cwd/tmp/cache and denies non-localhost
	// network. Children inherit that profile, so the script body runs with
	// the same kernel guarantees pi itself does. Capability declarations on
	// the input drive policy gating + the approval card; they don't add a
	// further runtime clamp.
	const scratchDir = mkdtempSync(join(tmpdir(), "permissions-rs-"));
	const scriptPath = join(scratchDir, `script.${EXTENSION[input.language]}`);

	writeFileSync(scriptPath, input.source, { mode: 0o600 });

	const env = { ...process.env };
	if (input.capabilities.net === "none") {
		// Strip the proxy env vars so subprocesses don't think the proxy is
		// up. The outer sandbox already kernel-denies non-localhost net; this
		// just keeps libraries from pointing themselves at 127.0.0.1:8443.
		delete env.HTTPS_PROXY;
		delete env.HTTP_PROXY;
		delete env.https_proxy;
		delete env.http_proxy;
	}

	const child = spawn(
		INTERPRETER[input.language],
		[scriptPath, ...(input.args ?? [])],
		{
			cwd: opts.cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			signal: opts.signal,
		},
	);

	let stdout = "";
	let stderr = "";
	const STDOUT_CAP = 1024 * 1024; // 1 MiB
	const STDERR_CAP = 256 * 1024;
	child.stdout?.on("data", (b: Buffer) => {
		if (stdout.length < STDOUT_CAP) stdout += b.toString("utf8");
	});
	child.stderr?.on("data", (b: Buffer) => {
		if (stderr.length < STDERR_CAP) stderr += b.toString("utf8");
	});

	if (input.stdin) child.stdin?.write(input.stdin);
	child.stdin?.end();

	let timedOut = false;
	const timer = opts.timeoutMs
		? setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, opts.timeoutMs)
		: null;

	const exitCode = await new Promise<number | null>((resolve) => {
		child.once("close", (code) => resolve(code));
		child.once("error", () => resolve(null));
	});
	if (timer) clearTimeout(timer);

	try {
		rmSync(scratchDir, { recursive: true, force: true });
	} catch {
		// best effort
	}

	return { stdout, stderr, exitCode, timedOut, scratchDir };
}
