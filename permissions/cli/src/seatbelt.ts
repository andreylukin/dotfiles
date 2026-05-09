export function seatbeltProfile(_socketPath: string): string {
	// Spec calls for `(deny default)` plus a small allowlist, but a strict
	// deny-default profile breaks pi's TUI: setRawMode on the controlling tty
	// returns EPERM, and the only macOS-supplied way to grant tty ioctls is via
	// `(extension "com.apple.sandbox.pty")` which sandbox-exec doesn't issue.
	// Fragile to enumerate every system service pi touches.
	//
	// Pivot: `(allow default)` then `(deny network*)` with selective allows.
	// Same network-egress guarantee (the spec verify case — direct curl to
	// api.github.com from within the box — still fails) without the
	// permission-whack-a-mole.
	//
	// Also: macOS Seatbelt rejects path filters on unix sockets; the only
	// outbound-unix-socket form that works is unfiltered `(remote unix-socket)`.
	return [
		"(version 1)",
		"(allow default)",
		"(deny network*)",
		'(allow network* (remote ip "localhost:*"))',
		"(allow network-outbound (remote unix-socket))",
		"",
	].join("\n");
}
