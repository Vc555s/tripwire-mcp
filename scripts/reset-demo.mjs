// Puts the demo back to its starting state, so every rehearsal begins the same way.
//   node scripts/reset-demo.mjs               everything below
//   node scripts/reset-demo.mjs --store-only  only step 1
// 1. Restores the seeded Tripwire store (promises + baseline, no later runs).
// 2. Puts the shop's working copy back on the buggy branch and redeploys it.
// 3. Closes the regression issues Tripwire filed and removes its comments from the demo issue.
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import { copyDir, loadEnv } from "./demo-lib.mjs";

const env = loadEnv();
const storeOnly = process.argv.includes("--store-only");
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

if (!fs.existsSync(env.SEED_HOME)) {
  console.error(`No seed at ${env.SEED_HOME}. Run node scripts/seed-demo.mjs first.`);
  process.exit(1);
}
copyDir(env.SEED_HOME, env.TRIPWIRE_HOME);
console.log(`store restored: ${env.TRIPWIRE_HOME}`);

if (!storeOnly) {
  const shop = env.DEMO_SHOP_DIR;
  const branch = env.DEMO_BRANCH ?? "refactor-price";
  sh(`git checkout -q ${branch}`, shop);
  sh(`git reset -q --hard origin/${branch}`, shop);
  console.log(`shop working copy: ${branch} at ${sh("git log --oneline -1", shop)}`);
  sh(`netlify deploy --no-build --alias ${branch} --dir . --message "reset: buggy build"`, shop);
  console.log(`redeployed the buggy build to ${env.BRANCH_URL}`);

  const repo = env.GITHUB_REPO;
  const open = JSON.parse(gh("issue", "list", "--repo", repo, "--label", "tripwire", "--state", "open", "--json", "number"));
  for (const { number } of open) gh("issue", "close", String(number), "--repo", repo, "--reason", "not planned", "--comment", "Closed by the demo reset.");
  const issue = env.DEMO_ISSUE ?? "1";
  const comments = JSON.parse(gh("api", `repos/${repo}/issues/${issue}/comments`, "--paginate"));
  const mine = comments.filter((c) => c.body.startsWith("Tripwire:"));
  for (const c of mine) gh("api", "-X", "DELETE", `repos/${repo}/issues/comments/${c.id}`);
  console.log(`GitHub: closed ${open.length} regression issue(s), removed ${mine.length} Tripwire comment(s) from #${issue}`);
}
console.log("ready");
