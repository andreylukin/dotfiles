import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as mockttp from "mockttp";

const CA_DIR = path.join(os.homedir(), ".permissions");
const CA_CERT = path.join(CA_DIR, "ca.crt");
const CA_KEY = path.join(CA_DIR, "ca.key");
const CA_BUNDLE = path.join(CA_DIR, "ca-bundle.crt");
const SYSTEM_ROOTS = "/etc/ssl/cert.pem"; // macOS

export interface CA {
	cert: string;
	key: string;
	certPath: string;
	bundlePath: string;
	fresh: boolean;
}

export async function ensureCa(): Promise<CA> {
	await fs.mkdir(CA_DIR, { recursive: true });
	let cert: string;
	let key: string;
	let fresh = false;
	try {
		[cert, key] = await Promise.all([
			fs.readFile(CA_CERT, "utf8"),
			fs.readFile(CA_KEY, "utf8"),
		]);
	} catch {
		const generated = await mockttp.generateCACertificate();
		cert = generated.cert;
		key = generated.key;
		await fs.writeFile(CA_CERT, cert);
		await fs.writeFile(CA_KEY, key, { mode: 0o600 });
		fresh = true;
	}

	let bundle = cert;
	try {
		const sys = await fs.readFile(SYSTEM_ROOTS, "utf8");
		bundle = `${cert}\n${sys}`;
	} catch {
		// system roots unavailable; bundle = our CA only
	}
	await fs.writeFile(CA_BUNDLE, bundle);

	return { cert, key, certPath: CA_CERT, bundlePath: CA_BUNDLE, fresh };
}
