import { proposeBashRegexLadder } from "./src/index.js";

function covers(regex: string, input: string): boolean {
  try { return new RegExp(`^(?:${regex})$`).test(input); } catch { return false; }
}

const cases = [
  "git status",
  "npm install -g lodash",
  "cat ~/.npmrc",
  "rm -rf /tmp/build",
  "rmdir build",
  "echo hello > /tmp/out",
  "git push origin main",
  "pwd",
  "ls -la /Users/andrey/repos/dotfiles",
];

const lockedInputs = new Set(["rm -rf /tmp/build", "rmdir build", "echo hello > /tmp/out", "git push origin main"]);

for (const c of cases) {
  const t0 = performance.now();
  const out = await proposeBashRegexLadder(c, 3);
  const dt = (performance.now() - t0).toFixed(0);
  console.log(`\n=== ${c}  (${dt}ms)`);
  if (out === null) { console.log("(null — model failed)"); continue; }
  out.forEach((v, i) => {
    const m = covers(v.regex, c);
    console.log(`v${i+1} ${m?"✓":"✗"}  ${v.regex}\n        ${v.reason}`);
  });
  if (lockedInputs.has(c)) {
    const allEqual = out.every((v) => v.regex === out[0].regex);
    console.log(`HARD LOCK check: ${allEqual ? "✓ all 3 identical" : "✗ VIOLATED — variants differ"}`);
  }
}
