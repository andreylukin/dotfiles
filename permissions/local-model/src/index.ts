export { callModel, streamModel, DEFAULT_MODEL, DEFAULT_OLLAMA_URL, OllamaUnavailableError } from "./model.js";
export type { ModelCall, ModelOpts } from "./model.js";
export { BASH_SEGMENT_PROMPT, BASH_LADDER_PROMPT, NET_GLOB_PROMPT } from "./prompts.js";
export { globToRegex } from "./glob.js";

import { callModel, streamModel, OllamaUnavailableError, type ModelOpts } from "./model.js";
import { BASH_SEGMENT_PROMPT, BASH_LADDER_PROMPT, NET_GLOB_PROMPT } from "./prompts.js";

export interface BashProposal {
  regex: string;
  reason: string | null;
}

export interface NetProposal {
  glob: string;
  reason: string | null;
}

const TAG_REGEX = /<regex>([\s\S]*?)<\/regex>/i;
const TAG_GLOB = /<glob>([\s\S]*?)<\/glob>/i;
const TAG_REASON = /<reason>([\s\S]*?)<\/reason>/i;

/** Parse <reason> and <regex> tags from model output. Falls back to treating
 * the whole content as the regex if no <regex> tag is found. */
function parseBashProposal(content: string): BashProposal | null {
  const regexMatch = TAG_REGEX.exec(content);
  const reasonMatch = TAG_REASON.exec(content);
  let regex: string;
  if (regexMatch) {
    regex = regexMatch[1].trim();
  } else {
    // Fallback: assume model forgot tags and emitted just the regex.
    regex = content.trim();
  }
  if (!regex) return null;
  return { regex, reason: reasonMatch ? reasonMatch[1].trim() : null };
}

/**
 * Propose a regex (with reasoning) for a single bash command segment.
 * Returns null if ollama is unavailable or the model produces no regex.
 */
export async function proposeBashRegex(
  segment: string,
  opts: Omit<ModelOpts, "system" | "user"> = {},
): Promise<BashProposal | null> {
  return runProposal(BASH_SEGMENT_PROMPT, segment, opts, "segment");
}

/**
 * Propose a ladder of `count` regex variants for a single bash command segment,
 * ordered from MOST GENERAL (index 0) to MOST SPECIFIC / literal (index count-1).
 *
 * Returns up to `count` variants in order; the caller is responsible for validating
 * each against the input segment + lint and deduping. Returns null on ollama failure.
 */
export async function proposeBashRegexLadder(
  segment: string,
  count = 3,
  opts: Omit<ModelOpts, "system" | "user"> = {},
): Promise<BashProposal[] | null> {
  const userMessage = `Input: ${segment}\n\nProduce exactly ${count} variants from MOST GENERAL (v1) to MOST SPECIFIC (v${count}). Begin with <v1> and finish with <v${count}>. Output nothing else.`;
  try {
    const { content } = await callModel({
      ...opts,
      system: BASH_LADDER_PROMPT,
      user: userMessage,
      // Each variant ~80 tokens × 3 + structure. 600 leaves headroom; cut-offs
      // produce unparseable output (no closing tag) and we'd rather pay tokens
      // than retry.
      maxTokens: opts.maxTokens ?? 600,
    });
    if (!content) {
      console.error(
        `[permissions/local-model] empty content (ladder) for segment ${JSON.stringify(segment)}`,
      );
      return null;
    }
    const parsed = parseLadder(content);
    if (parsed.length === 0) {
      console.error(
        `[permissions/local-model] could not parse any ladder variants from content: ${JSON.stringify(content.slice(0, 400))}`,
      );
      return null;
    }
    return parsed;
  } catch (e) {
    if (e instanceof OllamaUnavailableError) {
      console.error(`[permissions/local-model] ollama unreachable (ladder): ${e.message}`);
      return null;
    }
    console.error(`[permissions/local-model] unexpected error (ladder):`, e);
    return null;
  }
}

const TAG_VARIANT = /<v(\d+)>([\s\S]*?)<\/v\1>/gi;

/** Parse <vN><reason>...</reason><regex>...</regex></vN> blocks in order. */
function parseLadder(content: string): BashProposal[] {
  const out: BashProposal[] = [];
  for (const m of content.matchAll(TAG_VARIANT)) {
    const inner = m[2];
    const proposal = parseBashProposal(inner);
    if (proposal) out.push(proposal);
  }
  // Fallback: model didn't use <vN> tags but may have produced N flat
  // <reason>/<regex> pairs. Pull pairs in document order.
  if (out.length === 0) {
    const reasonRe = /<reason>([\s\S]*?)<\/reason>/gi;
    const regexRe = /<regex>([\s\S]*?)<\/regex>/gi;
    const reasons = [...content.matchAll(reasonRe)].map((m) => m[1].trim());
    const regexes = [...content.matchAll(regexRe)].map((m) => m[1].trim());
    for (let i = 0; i < regexes.length; i++) {
      const r = regexes[i];
      if (!r) continue;
      out.push({ regex: r, reason: reasons[i] ?? null });
    }
  }
  return out;
}

/**
 * Refine an existing regex based on user feedback (e.g., "allow any package").
 * The model is given the original segment, the current regex, and the user's
 * free-form refinement request. Returns null on ollama failure.
 */
/** Match "wiki *", "wiki  *", "*", "* anything", or just "*" — glob-style directives. */
const WILDCARD_DIRECTIVE = /^\s*(?:([A-Za-z][\w@/.-]*)\s+)?\*+\s*$/;

/**
 * Synthesize a wildcard-after-binary regex when the user types a glob-style
 * directive (e.g., "wiki *", "*", "git *"). Returns null if the directive
 * doesn't match the glob pattern. Skips the model entirely — deterministic
 * and instant. The caller still runs full validation.
 */
function detectWildcardAfterBinary(segment: string, directive: string): BashProposal | null {
  const m = WILDCARD_DIRECTIVE.exec(directive);
  if (!m) return null;
  const segmentBinary = segment.trim().split(/\s+/)[0];
  if (!segmentBinary) return null;
  // If the directive specified a binary ("wiki *"), require it match the
  // segment's binary — guards against typos.
  if (m[1] && m[1] !== segmentBinary) return null;
  const escaped = segmentBinary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    regex: `^${escaped}( --?[\\w-]+(=[\\w./~@:_-]+)?)*( ([\\w./~@:_-]+|'[^']*'|"[^"]*"))*$`,
    reason: `Wildcard-after-binary: ${segmentBinary} stays literal; everything after (subcommand, args, flags) is flexible.`,
  };
}

function buildRefineBashUserMessage(segment: string, currentRegex: string, userFeedback: string): string {
  return [
    `Refine an existing regex based on user feedback.`,
    ``,
    `Original input: ${segment}`,
    `Current regex: ${currentRegex}`,
    `User wants: ${userFeedback}`,
    ``,
    `HARD RULE — DO NOT VIOLATE: your new regex MUST full-match the original input character-by-character. Every literal character in the original must appear (literally or via a class) in your regex, in order. If you drop, simplify, or omit any token from the original, validation will reject your output.`,
    ``,
    `If the user asks for an "exact", "literal", "verbatim", "strict", "limited", or "only this" match: output the original input as a literal regex with regex-special chars escaped. Example: input \`npm install -g lodash\` → \`^npm install -g lodash$\`. Keep ALL flags, options, and arguments exactly as they appear.`,
    ``,
    `If the user asks to broaden/generalize using words like "general", "generic", "any", "broad", "wider", "all", "all of them", "broaden", "loose", or "any X": REPLACE the variable parts of the regex with safe character classes. Keep the binary literal; subcommands stay literal by default but ARE wildcardable when the user asks (see next rule). The new regex must accept MORE inputs than the current one — if your output is character-for-character identical to the input, you have failed the user's request.`,
    ``,
    `WILDCARD-AFTER-BINARY directive: if the user's directive uses a glob-like wildcard for what comes after the binary — e.g., "binary *", "wiki *", "any subcommand", "just use binary", "binary anything", "any X command" — wildcard EVERYTHING after the binary, including the subcommand. The binary stays literal; the rest becomes a flexible match for subcommand + positional args + flags. Use the pattern \`^<binary>( --?[\\w-]+(=[\\w./~@:_-]+)?)*( ([\\w./~@:_-]+|'[^']*'|"[^"]*"))*$\` adapted as needed. The positional alternation \`([\\w./~@:_-]+|'[^']*'|"[^"]*")\` covers bare tokens, single-quoted strings, and double-quoted strings (including spaces inside quotes). Always include all three alternatives unless you know the command never takes quoted args.`,
    ``,
    `Other rules:`,
    `- ALWAYS terminate the regex with \`$\`. Output must start with \`^\` and end with \`$\`.`,
    `- Use safe character classes (no .*, .+, \\S+, \\W+)`,
    `- Keep URL hosts literal (escape dots with \\.)`,
    ``,
    `Examples:`,
    ``,
    `Original: npm install -g lodash`,
    `Current: ^npm install( --?[\\w-]+(=[\\w./~@:_-]+)?)* lodash( --?[\\w-]+(=[\\w./~@:_-]+)?)*$`,
    `User: only this exact command`,
    `Output: <reason>Locked to literal command per user request.</reason><regex>^npm install -g lodash$</regex>`,
    ``,
    `Original: npm install -g lodash`,
    `Current: ^npm install( --?[\\w-]+(=[\\w./~@:_-]+)?)* lodash( --?[\\w-]+(=[\\w./~@:_-]+)?)*$`,
    `User: allow any package, not just lodash`,
    `Output: <reason>Replaced literal lodash with a package-name char class.</reason><regex>^npm install( --?[\\w-]+(=[\\w./~@:_-]+)?)* [\\w@/.-]+( --?[\\w-]+(=[\\w./~@:_-]+)?)*$</regex>`,
    ``,
    `Original: cat ~/.npmrc`,
    `Current: ^cat [\\w./~_-]+$`,
    `User: only home-relative paths`,
    `Output: <reason>Restricted path class to require leading ~/.</reason><regex>^cat ~/[\\w./_-]+$</regex>`,
    ``,
    `Original: ls /Users/andrey/repos/dotfiles/`,
    `Current: ^ls /Users/andrey/repos/dotfiles/$`,
    `User: just make it a general ls`,
    `Output: <reason>Generalized to any ls invocation with optional flags and any path-like target.</reason><regex>^ls( --?[\\w-]+)*( [\\w./~_-]+)?$</regex>`,
    ``,
    `Original: ls /tmp`,
    `Current: ^ls /tmp$`,
    `User: any path`,
    `Output: <reason>Generalized path argument; ls binary stays literal, optional flags allowed.</reason><regex>^ls( --?[\\w-]+)*( [\\w./~_-]+)$</regex>`,
    ``,
    `Original: grep -r 'TODO' src`,
    `Current: ^grep -r 'TODO' src$`,
    `User: any pattern, any path`,
    `Output: <reason>Generalized the quoted pattern and path target; grep -r kept literal.</reason><regex>^grep -r '[^']+' [\\w./~_-]+$</regex>`,
    ``,
    `Original: wiki list concepts --json`,
    `Current: ^wiki list concepts( --?[\\w-]+)* --json$`,
    `User: just use wiki *`,
    `Output: <reason>Wildcard-after-binary: wiki binary stays literal; subcommand, positional args (incl. quoted strings), and flags all flexible.</reason><regex>^wiki( --?[\\w-]+(=[\\w./~@:_-]+)?)*( ([\\w./~@:_-]+|'[^']*'|"[^"]*"))*$</regex>`,
    ``,
    `Original: wiki search "permissions pi"`,
    `Current: ^wiki search "permissions pi"$`,
    `User: any wiki command`,
    `Output: <reason>Wildcard-after-binary with quoted-arg support; binary stays literal.</reason><regex>^wiki( --?[\\w-]+(=[\\w./~@:_-]+)?)*( ([\\w./~@:_-]+|'[^']*'|"[^"]*"))*$</regex>`,
    ``,
    `Original: git log --oneline -n 20`,
    `Current: ^git log( --?[\\w-]+(=[\\w./~@:_-]+)?)* -n 20$`,
    `User: any git subcommand`,
    `Output: <reason>Wildcard-after-binary: git binary stays literal; subcommand and args flexible.</reason><regex>^git( --?[\\w-]+(=[\\w./~@:_-]+)?)*( ([\\w./~@:_-]+|'[^']*'|"[^"]*"))*$</regex>`,
    ``,
    `Now refine the regex. Output format: <reason>brief explanation</reason><regex>^...$</regex>`,
  ].join("\n");
}

export async function refineBashRegex(
  segment: string,
  currentRegex: string,
  userFeedback: string,
  opts: Omit<ModelOpts, "system" | "user"> = {},
): Promise<BashProposal | null> {
  const userMessage = buildRefineBashUserMessage(segment, currentRegex, userFeedback);
  return runProposal(BASH_SEGMENT_PROMPT, userMessage, opts, "refine-segment");
}

/**
 * Streaming refinement. Calls onChunk with the accumulated raw model output as
 * each token arrives — the widget uses this to render a live preview. Returns
 * the parsed proposal on completion (or null on failure / unparseable output).
 */
export async function streamRefineBashRegex(
  segment: string,
  currentRegex: string,
  userFeedback: string,
  onChunk: (accumulated: string) => void,
  opts: Omit<ModelOpts, "system" | "user"> = {},
): Promise<BashProposal | null> {
  // Code-side shortcut: glob-style directives like "wiki *" or bare "*" are
  // deterministic enough to synthesize without a model call. The small model
  // tends to interpret literal "*" as a character wildcard and produces wrong
  // output even with prompt examples; synthesize from the segment's binary.
  const shortcut = detectWildcardAfterBinary(segment, userFeedback);
  if (shortcut) return shortcut;
  const userMessage = buildRefineBashUserMessage(segment, currentRegex, userFeedback);
  let acc = "";
  try {
    for await (const chunk of streamModel({
      ...opts,
      system: BASH_SEGMENT_PROMPT,
      user: userMessage,
      maxTokens: opts.maxTokens ?? 200,
    })) {
      acc += chunk;
      onChunk(acc);
    }
  } catch (e) {
    if (e instanceof OllamaUnavailableError) {
      console.error(`[permissions/local-model] ollama unreachable (stream-refine): ${e.message}`);
      return null;
    }
    if ((e as { name?: string })?.name === "AbortError") return null;
    console.error(`[permissions/local-model] unexpected error (stream-refine):`, e);
    return null;
  }
  if (!acc.trim()) return null;
  return parseBashProposal(acc);
}

/**
 * Retry a regex proposal with feedback after the first attempt was rejected.
 * Returns null on ollama failure or empty content.
 */
export async function retryBashRegex(
  segment: string,
  previousRegex: string,
  failureReason: string,
  opts: Omit<ModelOpts, "system" | "user"> = {},
): Promise<BashProposal | null> {
  const tokens = segment.split(/\s+/).filter((t) => t.length > 0);
  const userMessage = [
    `Your previous regex was rejected by a safety check. Fix it.`,
    ``,
    `Original input: ${segment}`,
    `Tokens (whitespace-separated): ${tokens.map((t) => JSON.stringify(t)).join(", ")}`,
    `Previous regex: ${previousRegex}`,
    `Why it failed: ${failureReason}`,
    ``,
    `Walk through the tokens one by one and make sure your regex accommodates EACH of them.`,
    `Pay special attention to:`,
    `- Positional arguments (tokens that don't start with - or --) between flags`,
    `- Mixed orders of flags and positional args (e.g., \`cmd -flag pos --other-flag value\`)`,
    `- Tokens that contain special chars like ., /, @, ~, _ — use [\\w./~@_-]+ to match them`,
    ``,
    `Test your new regex against the original input mentally before responding.`,
    `Output format unchanged: <reason>...</reason><regex>^...$</regex>`,
  ].join("\n");
  return runProposal(BASH_SEGMENT_PROMPT, userMessage, opts, "retry-segment");
}

async function runProposal(
  system: string,
  user: string,
  opts: Omit<ModelOpts, "system" | "user">,
  label: string,
): Promise<BashProposal | null> {
  try {
    const { content } = await callModel({
      ...opts,
      system,
      user,
      maxTokens: opts.maxTokens ?? 200,
    });
    if (!content) {
      console.error(`[permissions/local-model] empty content (${label}) for input ${JSON.stringify(user.slice(0, 80))}`);
      return null;
    }
    const parsed = parseBashProposal(content);
    if (!parsed) {
      console.error(
        `[permissions/local-model] could not parse regex (${label}) from content: ${JSON.stringify(content)}`,
      );
      return null;
    }
    return parsed;
  } catch (e) {
    if (e instanceof OllamaUnavailableError) {
      console.error(`[permissions/local-model] ollama unreachable (${label}): ${e.message}`);
      return null;
    }
    console.error(`[permissions/local-model] unexpected error (${label}):`, e);
    return null;
  }
}

/**
 * Propose a glob (with reasoning) for a network action (net:METHOD:host/path).
 * Returns null if ollama is unavailable or the model produces no glob.
 */
export async function proposeNetGlob(
  action: string,
  opts: Omit<ModelOpts, "system" | "user"> = {},
): Promise<NetProposal | null> {
  try {
    const { content } = await callModel({
      ...opts,
      system: NET_GLOB_PROMPT,
      user: action,
      maxTokens: opts.maxTokens ?? 200,
    });
    if (!content) {
      console.error(
        `[permissions/local-model] empty content (propose-net) for action ${JSON.stringify(action)}`,
      );
      return null;
    }
    const parsed = parseNetProposal(content);
    if (!parsed) {
      console.error(
        `[permissions/local-model] could not parse glob (propose-net) from content: ${JSON.stringify(content)}`,
      );
      return null;
    }
    return parsed;
  } catch (e) {
    if (e instanceof OllamaUnavailableError) {
      console.error(`[permissions/local-model] ollama unreachable (propose-net): ${e.message}`);
      return null;
    }
    console.error(`[permissions/local-model] unexpected error (propose-net):`, e);
    return null;
  }
}

/** Parse <reason> and <glob> tags from model output. Falls back to treating
 * the whole content as the glob if no <glob> tag is found. */
function parseNetProposal(content: string): NetProposal | null {
  const globMatch = TAG_GLOB.exec(content);
  const reasonMatch = TAG_REASON.exec(content);
  let glob: string;
  if (globMatch) {
    glob = globMatch[1].trim();
  } else {
    glob = content.trim();
  }
  if (!glob) return null;
  return { glob, reason: reasonMatch ? reasonMatch[1].trim() : null };
}

/**
 * Refine an existing glob based on user feedback (e.g., "any repo", "exact only").
 * The model is given the original action, the current glob, and the user's
 * free-form refinement request. Returns null on ollama failure.
 *
 * Hard rule: the new glob must still match the original action when expanded
 * (`*` = single path segment, `**` = anything). Validation enforces this at
 * the caller.
 */
export async function refineNetGlob(
  action: string,
  currentGlob: string,
  userFeedback: string,
  opts: Omit<ModelOpts, "system" | "user"> = {},
): Promise<NetProposal | null> {
  const userMessage = [
    `Refine an existing glob based on user feedback.`,
    ``,
    `Original input action: ${action}`,
    `Current glob: ${currentGlob}`,
    `User wants: ${userFeedback}`,
    ``,
    `HARD RULE — DO NOT VIOLATE: your new glob MUST match the original action when expanded ('*' = single path segment, no '/' no ':'; '**' = anything). If the new glob does not match the original action, validation will reject your output. Broadening a rule that no longer covers the input is useless.`,
    ``,
    `NEVER WILDCARD THE HOST. The text between the second ':' and the first '/' must stay character-for-character identical to the input. If the user asks for "any host", "any domain", "any registry", or similar — REFUSE: output the original action exactly with a reason explaining the refusal. Wildcarding the host means a future request to a different host would auto-approve. That is a security regression.`,
    ``,
    `NEVER CHANGE THE PREFIX. Output must start with 'net:'.`,
    ``,
    `If the user asks for "exact", "literal", "verbatim", "strict", or "only this": output the original action verbatim. Example: input \`net:GET:api.github.com/users/octocat\` → \`net:GET:api.github.com/users/octocat\`.`,
    ``,
    `If the user asks to broaden the PATH: drop the trailing data segment(s) and replace with '/**'. Verify the new glob still matches the original — '/**' requires a literal '/' before it, so the original must already have a slash at that position. Example: input \`/repos/foo/bar\` + "any repo" → \`/repos/**\` (matches because '/' follows 'repos' in the original).`,
    ``,
    `If the user asks for "any method" or "all methods": replace METHOD with '*'. Method wildcarding is allowed; host wildcarding is not.`,
    ``,
    `If the user's request requires a glob that does NOT match the original action (e.g., input \`host/foo\`, request "all sub-resources" → \`host/foo/**\` does not match plain \`host/foo\` because '/**' requires a slash after 'foo'): output the original action exactly with a reason explaining the limitation. Sub-resources must be approved separately when they fire.`,
    ``,
    `Examples:`,
    ``,
    `Original: net:GET:api.github.com/repos/foo/bar`,
    `Current: net:GET:api.github.com/repos/foo/bar`,
    `User: allow any repo`,
    `Output: <reason>Generalized the repo data tail; host and method stay literal.</reason><glob>net:GET:api.github.com/repos/**</glob>`,
    ``,
    `Original: net:GET:api.github.com/repos/foo/bar`,
    `Current: net:GET:api.github.com/repos/**`,
    `User: only this exact repo`,
    `Output: <reason>Locked to the literal action per user request.</reason><glob>net:GET:api.github.com/repos/foo/bar</glob>`,
    ``,
    `Original: net:POST:api.linear.app/graphql`,
    `Current: net:POST:api.linear.app/graphql`,
    `User: any method`,
    `Output: <reason>Method wildcarded; host and path stay literal.</reason><glob>net:*:api.linear.app/graphql</glob>`,
    ``,
    `Original: net:GET:registry.npmjs.org/lodash`,
    `Current: net:GET:registry.npmjs.org/**`,
    `User: any registry`,
    `Output: <reason>Refused host generalization — wildcarding the host would auto-approve other registries.</reason><glob>net:GET:registry.npmjs.org/lodash</glob>`,
    ``,
    `Original: net:DELETE:api.example.com/users/42`,
    `Current: net:DELETE:api.example.com/users/42`,
    `User: any user id`,
    `Output: <reason>Generalized the trailing user-id segment; method stays DELETE.</reason><glob>net:DELETE:api.example.com/users/**</glob>`,
    ``,
    `Now refine the glob. Output format: <reason>brief explanation</reason><glob>net:METHOD:host/path</glob>`,
  ].join("\n");

  try {
    const { content } = await callModel({
      ...opts,
      system: NET_GLOB_PROMPT,
      user: userMessage,
      maxTokens: opts.maxTokens ?? 200,
    });
    if (!content) {
      console.error(
        `[permissions/local-model] empty content (refine-net) for action ${JSON.stringify(action)}`,
      );
      return null;
    }
    const parsed = parseNetProposal(content);
    if (!parsed) {
      console.error(
        `[permissions/local-model] could not parse glob (refine-net) from content: ${JSON.stringify(content)}`,
      );
      return null;
    }
    return parsed;
  } catch (e) {
    if (e instanceof OllamaUnavailableError) {
      console.error(`[permissions/local-model] ollama unreachable (refine-net): ${e.message}`);
      return null;
    }
    console.error(`[permissions/local-model] unexpected error (refine-net):`, e);
    return null;
  }
}
