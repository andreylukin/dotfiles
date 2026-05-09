import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { callModel } from "./model.js";
import { BASH_SEGMENT_PROMPT, BASH_WHOLE_PROMPT, NET_GLOB_PROMPT } from "./prompts.js";
import { globToRegex, naiveSplit } from "./glob.js";

const SPIKE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const PASS = {
  format: 1.0,
  coverage: 0.9,
  generality: 0.75,
  tightness: 0.8,
  latencyP95Ms: 500,
};

interface EvalItem {
  input: string;
  kind: "shell" | "python" | "net";
  segments?: string[];
  plausible_variants: string[];
  should_not_match: string[];
}

interface ItemResult {
  input: string;
  pattern: string;
  format: boolean;
  coverage: boolean;
  generalityHits: number;
  generalityTotal: number;
  tightnessAvoids: number;
  tightnessTotal: number;
  latencyMs: number;
}

function loadJsonl(name: string): EvalItem[] {
  const raw = readFileSync(join(SPIKE_DIR, name), "utf-8");
  return raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function compileRegex(s: string): RegExp | null {
  try {
    return new RegExp(s);
  } catch {
    return null;
  }
}

function fullMatch(rx: RegExp, s: string): boolean {
  const m = rx.exec(s);
  return m !== null && m[0] === s;
}

async function runBashSegment(items: EvalItem[]): Promise<ItemResult[]> {
  const results: ItemResult[] = [];
  for (const item of items) {
    const { content, latencyMs } = await callModel({
      system: BASH_SEGMENT_PROMPT,
      user: item.input,
    });
    const rx = compileRegex(content);
    if (!rx) {
      results.push({
        input: item.input,
        pattern: content,
        format: false,
        coverage: false,
        generalityHits: 0,
        generalityTotal: item.plausible_variants.length,
        tightnessAvoids: 0,
        tightnessTotal: item.should_not_match.length,
        latencyMs,
      });
      continue;
    }
    const coverage = fullMatch(rx, item.input);
    const genHits = item.plausible_variants.filter((v) => fullMatch(rx, v)).length;
    const tightAvoids = item.should_not_match.filter((n) => !fullMatch(rx, n)).length;
    results.push({
      input: item.input,
      pattern: content,
      format: true,
      coverage,
      generalityHits: genHits,
      generalityTotal: item.plausible_variants.length,
      tightnessAvoids: tightAvoids,
      tightnessTotal: item.should_not_match.length,
      latencyMs,
    });
  }
  return results;
}

async function runBashWhole(items: EvalItem[]): Promise<ItemResult[]> {
  const results: ItemResult[] = [];
  for (const item of items) {
    const { content, latencyMs } = await callModel({
      system: BASH_WHOLE_PROMPT,
      user: item.input,
    });
    const rx = compileRegex(content);
    if (!rx) {
      results.push({
        input: item.input,
        pattern: content,
        format: false,
        coverage: false,
        generalityHits: 0,
        generalityTotal: item.plausible_variants.length,
        tightnessAvoids: 0,
        tightnessTotal: item.should_not_match.length,
        latencyMs,
      });
      continue;
    }
    const segs = item.segments ?? naiveSplit(item.input);
    const coverage = segs.every((s) => fullMatch(rx, s));
    const genHits = item.plausible_variants.filter((v) => {
      const vs = naiveSplit(v);
      return vs.length > 0 && vs.every((s) => fullMatch(rx, s));
    }).length;
    const tightAvoids = item.should_not_match.filter((n) => {
      const ns = naiveSplit(n);
      return !(ns.length > 0 && ns.every((s) => fullMatch(rx, s)));
    }).length;
    results.push({
      input: item.input,
      pattern: content,
      format: true,
      coverage,
      generalityHits: genHits,
      generalityTotal: item.plausible_variants.length,
      tightnessAvoids: tightAvoids,
      tightnessTotal: item.should_not_match.length,
      latencyMs,
    });
  }
  return results;
}

async function runBashPerSegment(items: EvalItem[]): Promise<ItemResult[]> {
  const results: ItemResult[] = [];
  for (const item of items) {
    const segs = item.segments ?? naiveSplit(item.input);
    const segRegexes: string[] = [];
    let totalLatency = 0;
    for (const seg of segs) {
      const { content, latencyMs } = await callModel({
        system: BASH_SEGMENT_PROMPT,
        user: seg,
      });
      segRegexes.push(content);
      totalLatency += latencyMs;
    }
    const compiled = segRegexes.map(compileRegex);
    if (compiled.some((r) => r === null)) {
      results.push({
        input: item.input,
        pattern: segRegexes.join(" || "),
        format: false,
        coverage: false,
        generalityHits: 0,
        generalityTotal: item.plausible_variants.length,
        tightnessAvoids: 0,
        tightnessTotal: item.should_not_match.length,
        latencyMs: totalLatency,
      });
      continue;
    }
    const rxs = compiled as RegExp[];
    const coveredAll = (cmd: string): boolean => {
      const ss = naiveSplit(cmd);
      if (ss.length === 0) return false;
      return ss.every((s) => rxs.some((rx) => fullMatch(rx, s)));
    };
    const coverage = coveredAll(item.input);
    const genHits = item.plausible_variants.filter(coveredAll).length;
    const tightAvoids = item.should_not_match.filter((n) => !coveredAll(n)).length;
    results.push({
      input: item.input,
      pattern: segRegexes.join(" || "),
      format: true,
      coverage,
      generalityHits: genHits,
      generalityTotal: item.plausible_variants.length,
      tightnessAvoids: tightAvoids,
      tightnessTotal: item.should_not_match.length,
      latencyMs: totalLatency,
    });
  }
  return results;
}

async function runNet(items: EvalItem[]): Promise<ItemResult[]> {
  const results: ItemResult[] = [];
  for (const item of items) {
    const { content, latencyMs } = await callModel({
      system: NET_GLOB_PROMPT,
      user: item.input,
    });
    const rx = globToRegex(content);
    if (!rx) {
      results.push({
        input: item.input,
        pattern: content,
        format: false,
        coverage: false,
        generalityHits: 0,
        generalityTotal: item.plausible_variants.length,
        tightnessAvoids: 0,
        tightnessTotal: item.should_not_match.length,
        latencyMs,
      });
      continue;
    }
    const coverage = fullMatch(rx, item.input);
    const genHits = item.plausible_variants.filter((v) => fullMatch(rx, v)).length;
    const tightAvoids = item.should_not_match.filter((n) => !fullMatch(rx, n)).length;
    results.push({
      input: item.input,
      pattern: content,
      format: true,
      coverage,
      generalityHits: genHits,
      generalityTotal: item.plausible_variants.length,
      tightnessAvoids: tightAvoids,
      tightnessTotal: item.should_not_match.length,
      latencyMs,
    });
  }
  return results;
}

function pct(num: number, denom: number): number {
  return denom === 0 ? 1 : num / denom;
}

function p95(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[Math.max(0, idx)];
}

function mark(passed: boolean): string {
  return passed ? "✓" : "✗";
}

function report(label: string, results: ItemResult[]): void {
  const n = results.length;
  const fmt = pct(results.filter((r) => r.format).length, n);
  const cov = pct(results.filter((r) => r.coverage).length, n);
  const genHits = results.reduce((a, r) => a + r.generalityHits, 0);
  const genTotal = results.reduce((a, r) => a + r.generalityTotal, 0);
  const gen = pct(genHits, genTotal);
  const tightAvoids = results.reduce((a, r) => a + r.tightnessAvoids, 0);
  const tightTotal = results.reduce((a, r) => a + r.tightnessTotal, 0);
  const tight = pct(tightAvoids, tightTotal);
  const lats = results.map((r) => r.latencyMs);
  const median = lats.length ? [...lats].sort((a, b) => a - b)[Math.floor(lats.length / 2)] : 0;
  const p95Lat = p95(lats);

  console.log(`\n=== ${label} (n=${n}) ===`);
  console.log(`  format:     ${(fmt * 100).toFixed(0)}%  ${mark(fmt >= PASS.format)}`);
  console.log(`  coverage:   ${(cov * 100).toFixed(0)}%  ${mark(cov >= PASS.coverage)}`);
  console.log(`  generality: ${(gen * 100).toFixed(0)}%  (${genHits}/${genTotal})  ${mark(gen >= PASS.generality)}`);
  console.log(`  tightness:  ${(tight * 100).toFixed(0)}%  (${tightAvoids}/${tightTotal})  ${mark(tight >= PASS.tightness)}`);
  console.log(`  latency:    p50=${median.toFixed(0)}ms  p95=${p95Lat.toFixed(0)}ms  ${mark(p95Lat <= PASS.latencyP95Ms)}`);

  console.log("\n  Misses:");
  let miss = 0;
  for (const r of results) {
    const probs: string[] = [];
    if (!r.format) probs.push("FMT");
    if (!r.coverage) probs.push("COV");
    if (r.generalityHits < r.generalityTotal) probs.push(`GEN ${r.generalityHits}/${r.generalityTotal}`);
    if (r.tightnessAvoids < r.tightnessTotal) probs.push(`TGT ${r.tightnessAvoids}/${r.tightnessTotal}`);
    if (probs.length) {
      const inp = r.input.length > 50 ? r.input.slice(0, 47) + "..." : r.input;
      const pat = r.pattern.length > 60 ? r.pattern.slice(0, 57) + "..." : r.pattern;
      console.log(`    [${probs.join(",")}]  ${JSON.stringify(inp)}  →  ${JSON.stringify(pat)}`);
      miss++;
    }
  }
  if (miss === 0) console.log("    (none)");
}

async function main(): Promise<void> {
  const bashSingle = loadJsonl("eval-bash.jsonl").filter((i) => i.kind === "shell");
  const bashMulti = loadJsonl("eval-bash-multi.jsonl");
  const net = loadJsonl("eval-net.jsonl");

  const modelName = process.env.SPIKE_MODEL ?? "qwen3.5:0.8b";
  console.log(`Model: ${modelName}`);
  console.log(
    `Pass: format ≥${(PASS.format * 100).toFixed(0)}%, coverage ≥${(PASS.coverage * 100).toFixed(0)}%, ` +
      `generality ≥${(PASS.generality * 100).toFixed(0)}%, tightness ≥${(PASS.tightness * 100).toFixed(0)}%, ` +
      `p95 < ${PASS.latencyP95Ms}ms`,
  );

  console.log("\n>>> Run 1: bash single-segment  (per-segment prompt)");
  report("bash single-segment", await runBashSegment(bashSingle));

  console.log("\n>>> Run 2: bash multi-segment  (whole-command prompt)");
  report("bash multi-segment / whole-command", await runBashWhole(bashMulti));

  console.log("\n>>> Run 3: bash multi-segment  (per-segment prompt, N model calls)");
  report("bash multi-segment / per-segment", await runBashPerSegment(bashMulti));

  console.log("\n>>> Run 4: net glob");
  report("net glob", await runNet(net));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
