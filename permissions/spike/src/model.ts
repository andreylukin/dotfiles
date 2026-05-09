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
}

export async function callModel(opts: ModelOpts): Promise<ModelCall> {
  const url = opts.ollamaUrl ?? "http://localhost:11434/api/chat";
  const body = {
    model: opts.model ?? process.env.SPIKE_MODEL ?? "qwen3.5:0.8b",
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
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`ollama ${resp.status}: ${await resp.text()}`);
  }
  const data = (await resp.json()) as {
    message?: { content?: string };
    eval_count?: number;
  };
  const latencyMs = performance.now() - t0;
  let content = (data.message?.content ?? "").trim();
  content = stripFences(content);
  return { content, latencyMs, evalCount: data.eval_count ?? 0 };
}

function stripFences(s: string): string {
  return s
    .replace(/^```\w*\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
}
