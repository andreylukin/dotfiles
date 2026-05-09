export const DEFAULT_MODEL = "qwen3.5:2b";
export const DEFAULT_OLLAMA_URL = "http://localhost:11434/api/chat";

export interface ModelCall {
  content: string;
  latencyMs: number;
  evalCount: number;
}

export interface ModelOpts {
  model?: string;
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  thinking?: boolean;
  ollamaUrl?: string;
  signal?: AbortSignal;
}

export class OllamaUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`ollama unreachable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "OllamaUnavailableError";
  }
}

export async function callModel(opts: ModelOpts): Promise<ModelCall> {
  const url = opts.ollamaUrl ?? DEFAULT_OLLAMA_URL;
  const body = {
    model: opts.model ?? DEFAULT_MODEL,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    stream: false,
    think: opts.thinking ?? false,
    options: {
      temperature: opts.temperature ?? 0,
      num_predict: opts.maxTokens ?? 80,
    },
  };
  const t0 = performance.now();
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    throw new OllamaUnavailableError(e);
  }
  if (!resp.ok) {
    throw new Error(`ollama ${resp.status}: ${await resp.text()}`);
  }
  const data = (await resp.json()) as {
    message?: { content?: string; thinking?: string };
    eval_count?: number;
  };
  const latencyMs = performance.now() - t0;
  const rawContent = data.message?.content ?? "";
  const thinking = data.message?.thinking ?? "";
  let content = rawContent.trim();
  content = stripFences(content);
  if (process.env.PERMISSIONS_DEBUG_MODEL) {
    console.error(
      `[permissions/local-model] ${latencyMs.toFixed(0)}ms model=${body.model} ` +
        `content=${JSON.stringify(content)} thinking_chars=${thinking.length} ` +
        `eval_count=${data.eval_count ?? 0}`,
    );
  }
  return { content, latencyMs, evalCount: data.eval_count ?? 0 };
}

function stripFences(s: string): string {
  return s
    .replace(/^```\w*\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
}

/**
 * Streaming variant of callModel. Yields content chunks (the model's
 * `message.content` deltas) as ollama emits them. Caller is responsible for
 * accumulating + parsing the final result. Throws OllamaUnavailableError on
 * connection failure.
 */
export async function* streamModel(opts: ModelOpts): AsyncGenerator<string, void, void> {
  const url = opts.ollamaUrl ?? DEFAULT_OLLAMA_URL;
  const body = {
    model: opts.model ?? DEFAULT_MODEL,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    stream: true,
    think: opts.thinking ?? false,
    options: {
      temperature: opts.temperature ?? 0,
      num_predict: opts.maxTokens ?? 200,
    },
  };
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    throw new OllamaUnavailableError(e);
  }
  if (!resp.ok) {
    throw new Error(`ollama ${resp.status}: ${await resp.text()}`);
  }
  if (!resp.body) throw new Error("ollama returned no response body");
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        try {
          const obj = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
          const chunk = obj.message?.content;
          if (typeof chunk === "string" && chunk.length > 0) yield chunk;
          if (obj.done) return;
        } catch {
          // ignore non-JSON lines from ollama
        }
      }
      nl = buf.indexOf("\n");
    }
  }
}
