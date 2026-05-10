import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED = path.resolve(HERE, "..", "..", "templates");
const USER = path.join(os.homedir(), ".permissions", "templates");

export function bundledTemplatesDir(): string {
	return BUNDLED;
}

export async function resolveTemplatePath(name: string): Promise<string> {
	const filename = `${name}.csp`;
	const userPath = path.join(USER, filename);
	if (await exists(userPath)) return userPath;
	const bundledPath = path.join(BUNDLED, filename);
	if (await exists(bundledPath)) return bundledPath;
	throw new Error(
		`template "${name}" not found in ${USER} or ${BUNDLED}`,
	);
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}
