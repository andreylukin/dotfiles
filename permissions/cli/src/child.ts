import { type ChildProcess, spawn } from "node:child_process";

export interface ChildOptions {
	args: string[];
	socketPath: string;
	caPath: string;       // proxy CA only — for additive vars (NODE_EXTRA_CA_CERTS)
	bundlePath: string;   // proxy CA + system roots — for vars that REPLACE default trust
	proxyUrl: string;
	profilePath: string;
}

export function spawnPi(opts: ChildOptions): ChildProcess {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HTTPS_PROXY: opts.proxyUrl,
		HTTP_PROXY: opts.proxyUrl,
		NO_PROXY: "localhost,127.0.0.1,::1",
		NODE_EXTRA_CA_CERTS: opts.caPath,
		CURL_CA_BUNDLE: opts.bundlePath,
		GIT_SSL_CAINFO: opts.bundlePath,
		REQUESTS_CA_BUNDLE: opts.bundlePath,
		SSL_CERT_FILE: opts.bundlePath,
		PI_PERMISSIONS_SOCK: opts.socketPath,
	};

	return spawn("sandbox-exec", ["-f", opts.profilePath, "pi", ...opts.args], {
		env,
		stdio: "inherit",
	});
}
