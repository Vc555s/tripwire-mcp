// Dress rehearsal of the whole demo without the editor, against the real sites and the real GitHub repo:
// reset -> guard (BROKEN) -> file the issue -> fix the shop -> redeploy -> guard (SAFE) -> reset.
// Saves the reports and the failing screenshot to EVIDENCE_DIR as a backup for the live demo.
//   node scripts/rehearse.mjs
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connect, loadEnv, ROOT } from "./demo-lib.mjs";

const env = loadEnv();
const out = path.resolve(env.EVIDENCE_DIR ?? path.join(ROOT, "..", "demo-evidence"));
const branch = env.DEMO_BRANCH ?? "refactor-price";
const issue = Number(env.DEMO_ISSUE ?? 1);
const reset = () => execFileSync(process.execPath, [path.join(ROOT, "scripts", "reset-demo.mjs")], { stdio: "inherit" });
const shop = (cmd) => execSync(cmd, { cwd: env.DEMO_SHOP_DIR, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
const step = (n, what) => console.log(`\n[${n}] ${what}`);

step(0, "reset");
reset();
fs.mkdirSync(out, { recursive: true });
const { client, call } = await connect(env);
let ok = false;
try {
  const siteId = (await call("tripwire_history", { limit: 1 })).json.sites[0];

  step(1, "the promises, in the owner's words");
  for (const c of (await call("tripwire_list_checks", { siteId })).json.checks) console.log(`  ${c.priority.padEnd(8)} ${c.intent}`);

  step(2, `guard the branch deploy for #${issue}`);
  const broken = await call("tripwire_guard", { siteId, targetUrl: env.BRANCH_URL, change: { label: "refactor price helper", issue, files: ["price.js"] } });
  console.log(`  ${broken.json.verdict}: ${broken.json.headline}`);
  console.log(`  ${broken.json.regressions[0]?.detail}`);
  if (broken.json.verdict !== "BROKEN") throw new Error("expected BROKEN");
  fs.copyFileSync(broken.json.report, path.join(out, "report-broken.html"));
  fs.writeFileSync(path.join(out, "screenshot-broken.png"), Buffer.from(broken.images[0].data, "base64"));
  fs.writeFileSync(path.join(out, "verdict-broken.json"), JSON.stringify(broken.json, null, 2));

  step(3, "file it");
  const filed = (await call("tripwire_file_issue", { siteId })).json;
  console.log(`  filed #${filed.issue}: ${filed.url}\n  comment on #${filed.linkedTo}: ${filed.comment}`);
  if (!filed.comment?.startsWith("http")) throw new Error(`no comment on #${issue}: ${filed.comment}`);

  step(4, "fix the shop and redeploy");
  shop("git checkout main -- price.js");
  shop(`netlify deploy --no-build --alias ${branch} --dir . --message "fix: restore the discount"`);

  step(5, "guard again");
  const safe = (await call("tripwire_guard", { siteId, targetUrl: env.BRANCH_URL, change: { label: "restore the discount", issue, files: ["price.js"] } })).json;
  console.log(`  ${safe.verdict}: ${safe.headline}`);
  if (safe.verdict !== "SAFE") throw new Error(`expected SAFE, got ${safe.verdict}: ${JSON.stringify(safe.regressions)}`);
  fs.copyFileSync(safe.report, path.join(out, "report-safe.html"));

  fs.writeFileSync(path.join(out, "README.md"), [
    "# Demo evidence",
    "",
    `Captured ${new Date().toISOString()} by \`scripts/rehearse.mjs\` against the real sites and the real GitHub repo.`,
    "Open these if the live demo cannot run.",
    "",
    `- \`report-broken.html\`: the BROKEN report for ${env.BRANCH_URL}`,
    "- `screenshot-broken.png`: the screenshot the agent shows in chat",
    "- `verdict-broken.json`: the exact verdict returned to the agent",
    "- `report-safe.html`: the SAFE report after the fix",
    `- Regression issue filed by Tripwire: ${filed.url} (closed by the reset; the page still shows it)`,
    `- The issue that caused it: https://github.com/${env.GITHUB_REPO}/issues/${issue}`,
    "",
  ].join("\n"));
  ok = true;
} catch (e) {
  console.error(`\nrehearsal failed: ${e.message}`);
} finally {
  await client.close().catch(() => {});
  step(6, "reset");
  reset();
}
console.log(ok ? `\nRehearsal passed. Evidence in ${out}` : "\nRehearsal FAILED.");
process.exit(ok ? 0 : 1);
