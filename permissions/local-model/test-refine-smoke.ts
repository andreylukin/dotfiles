import { refineBashRegex } from "./src/index.js";

function covers(regex: string, input: string): boolean {
  try { return new RegExp(`^(?:${regex})$`).test(input); } catch { return false; }
}

const cases = [
  { segment: "ls /Users/andrey/repos/dotfiles/", current: "^ls /Users/andrey/repos/dotfiles/$", user: "just make it a general ls" },
  { segment: "ls /Users/andrey/repos/dotfiles/", current: "^ls /Users/andrey/repos/dotfiles/$", user: "any ls command" },
  { segment: "ls -la /Users/andrey/repos/dotfiles/", current: "^ls -la /Users/andrey/repos/dotfiles/$", user: "any path" },
  { segment: "cat package.json", current: "^cat package\\.json$", user: "any file" },
];

for (const c of cases) {
  const t0 = performance.now();
  const out = await refineBashRegex(c.segment, c.current, c.user);
  const dt = (performance.now() - t0).toFixed(0);
  console.log(`\n=== "${c.user}" on "${c.segment}"  (${dt}ms)`);
  if (out === null) { console.log("  (null — model failed)"); continue; }
  const matches = covers(out.regex, c.segment);
  const literal = out.regex === `^${c.segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
  const broader = !literal && out.regex !== c.current;
  console.log(`  reason: ${out.reason}`);
  console.log(`  regex:  ${out.regex}`);
  console.log(`  ${matches ? "✓" : "✗"} covers input   ${broader ? "✓ broader" : (literal ? "✗ collapsed to literal" : "= unchanged")}`);
}
