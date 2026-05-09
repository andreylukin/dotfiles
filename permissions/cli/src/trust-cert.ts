// Adds the proxy's CA certificate to the macOS user trust store so Go binaries
// (restish, gh, etc.) and other tools using Security.framework trust it.
//
// Why a Swift helper: `security add-trusted-cert` always prompts for password.
// SecTrustSettingsSetTrustSettings(cert, .user, nil) doesn't — user-domain
// trust settings don't require auth. Same approach as closedshell.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TRUST_DIR = path.join(os.homedir(), ".permissions");
const HELPER_BIN = path.join(TRUST_DIR, "trust-cert");
const HELPER_SRC = path.join(TRUST_DIR, "trust-cert.swift");
const TRUSTED_MARKER = path.join(TRUST_DIR, ".ca-trusted");

const SWIFT_SOURCE = `import Foundation
import Security
guard CommandLine.arguments.count == 2 else { exit(1) }
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let pem = try! String(contentsOf: url, encoding: .utf8)
    .replacingOccurrences(of: "-----BEGIN CERTIFICATE-----", with: "")
    .replacingOccurrences(of: "-----END CERTIFICATE-----", with: "")
    .replacingOccurrences(of: "\\n", with: "")
    .replacingOccurrences(of: "\\r", with: "")
guard let der = Data(base64Encoded: pem),
      let cert = SecCertificateCreateWithData(nil, der as CFData) else { exit(1) }
guard SecTrustSettingsSetTrustSettings(cert, .user, nil) == errSecSuccess else { exit(1) }
`;

async function exists(p: string): Promise<boolean> {
	return fs
		.access(p)
		.then(() => true)
		.catch(() => false);
}

function run(cmd: string, args: string[]): Promise<number> {
	return new Promise((resolve, reject) => {
		const proc = spawn(cmd, args, { stdio: "inherit" });
		proc.on("exit", (code) => resolve(code ?? 1));
		proc.on("error", reject);
	});
}

async function ensureHelper(): Promise<boolean> {
	if (await exists(HELPER_BIN)) return true;
	try {
		await fs.writeFile(HELPER_SRC, SWIFT_SOURCE);
		const rc = await run("swiftc", ["-O", "-o", HELPER_BIN, HELPER_SRC]);
		await fs.unlink(HELPER_SRC).catch(() => {});
		return rc === 0;
	} catch {
		return false;
	}
}

export interface TrustResult {
	ok: boolean;
	skipped?: boolean;
	reason?: string;
}

export async function trustCa(caPath: string): Promise<TrustResult> {
	if (process.platform !== "darwin") {
		return { ok: false, reason: "trust-cert is macOS-only" };
	}
	if (await exists(TRUSTED_MARKER)) return { ok: true, skipped: true };
	if (!(await ensureHelper())) {
		return {
			ok: false,
			reason:
				"swiftc not available — install Xcode Command Line Tools (xcode-select --install), or trust the CA manually via Keychain Access.app",
		};
	}
	const rc = await run(HELPER_BIN, [caPath]);
	if (rc !== 0) return { ok: false, reason: `trust-cert helper exited ${rc}` };
	await fs.writeFile(TRUSTED_MARKER, "");
	return { ok: true };
}
