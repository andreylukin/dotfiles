import * as os from "node:os";

function escapeSb(s: string): string {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface SeatbeltOpts {
	cwd: string;
}

/**
 * Outer pi sandbox.
 *
 * Strategy: keep `(allow default)` for everything except network and writes,
 * then explicitly deny those and re-allow a narrow set. `(deny default)` was
 * tried earlier and broke the TUI (setRawMode → EPERM on tty ioctls); this
 * narrower form keeps tty ioctls working while still kernel-clamping fs/net.
 *
 * Network: only localhost (the perm proxy) is reachable. Direct curl to e.g.
 * api.github.com fails at the kernel.
 *
 * File writes: only the project cwd, system tmp, pi/permissions config dirs,
 * common per-user caches, /dev fds, and shell history files. Anything outside
 * (e.g. `~/.ssh/authorized_keys`, `/etc/...`) is kernel-denied — and inherited
 * by every child process pi spawns, so an inline `python -c "..."` or a
 * misbehaving tool can't escape this clamp without a nested `sandbox-exec`
 * (which macOS blocks anyway, see runScript notes).
 *
 * Seatbelt rejects path filters on unix sockets, so the outbound-unix-socket
 * form is unfiltered.
 */
export function seatbeltProfile(_socketPath: string, opts: SeatbeltOpts): string {
	const home = os.homedir();
	const cwd = opts.cwd;

	const writableSubpaths = [
		cwd,
		// macOS resolves /var → /private/var; allow both forms so subpath rules
		// match no matter how the path was canonicalized by the caller.
		`/private${cwd}`,
		"/tmp",
		"/private/tmp",
		"/var/folders",
		"/private/var/folders",
		`${home}/.pi`,
		`${home}/.pi-lens`,
		`${home}/.permissions`,
		`${home}/.cache`,
		`${home}/.npm`,
		`${home}/.config`,
		`${home}/.local`,
		`${home}/Library/Caches`,
		`${home}/Library/Logs`,
	];

	const lines: string[] = [
		"(version 1)",
		// Surface every deny decision in the unified log so `permissions audit`
		// can show what got blocked. Without this, sandbox-exec profile denies
		// are silent (unlike App Store container sandboxes, which always log).
		"(debug deny)",
		"(allow default)",
		// Network
		"(deny network*)",
		'(allow network* (remote ip "localhost:*"))',
		"(allow network-outbound (remote unix-socket))",
		// File writes
		"(deny file-write*)",
	];
	for (const p of writableSubpaths) {
		lines.push(`(allow file-write* (subpath ${escapeSb(p)}))`);
	}
	lines.push(
		'(allow file-write* (literal "/dev/null"))',
		'(allow file-write* (literal "/dev/dtracehelper"))',
		'(allow file-write* (regex #"^/dev/tty"))',
		'(allow file-write* (regex #"^/dev/fd/"))',
		'(allow file-write* (regex #"^/dev/std"))',
		`(allow file-write* (literal ${escapeSb(`${home}/.zsh_history`)}))`,
		`(allow file-write* (literal ${escapeSb(`${home}/.bash_history`)}))`,
		`(allow file-write* (literal ${escapeSb(`${home}/.node_repl_history`)}))`,
		`(allow file-write* (literal ${escapeSb(`${home}/.python_history`)}))`,
		"",
	);
	return lines.join("\n");
}
