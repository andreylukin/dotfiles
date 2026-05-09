export type Action = string;

export function netAction(method: string, host: string, pathAndQuery: string): Action {
	return `net:${method}:${host}${pathAndQuery}`;
}

export function fileWriteAction(absPath: string): Action {
	return `file:write:${absPath}`;
}

export function bashAction(regex: string): Action {
	return `bash:${regex}`;
}
