import { proposeBashRegex, refineBashRegex } from "./src/index.js";

function covers(regex: string, input: string): boolean {
  try { return new RegExp(`^(?:${regex})$`).test(input); } catch { return false; }
}

const segment = "npm install -g lodash";

const first = await proposeBashRegex(segment);
if (first === null) { console.log("(unavailable)"); process.exit(1); }
console.log(`default: ${first.regex}\n`);

const refinements = [
  "make this very limited, only this exact command",
  "exact match only",
  "literal match",
  "allow any package, not just lodash",
  "broaden to any npm package — use [\\w@/.-]+ for the package",
];

for (const fb of refinements) {
  console.log(`\nrefine: "${fb}"`);
  const r = await refineBashRegex(segment, first.regex, fb);
  if (r === null) { console.log("  (unavailable)"); continue; }
  const ok = covers(r.regex, segment);
  console.log(`  → ${r.regex}`);
  console.log(`  matches original "${segment}"? ${ok ? "✓" : "✗ would be REJECTED"}`);
  if (ok) {
    const evil = covers(r.regex, "npm install evil");
    const lp = covers(r.regex, "npm install left-pad");
    console.log(`  also matches "npm install evil"?     ${evil}`);
    console.log(`  also matches "npm install left-pad"? ${lp}`);
  }
}
