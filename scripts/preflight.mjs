// Checks that everything the live demo depends on works right now. Exits non-zero on any failure.
//   node scripts/preflight.mjs
// The guard checks run on a temporary copy of the seeded store, so the demo's own store is not touched.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect, copyDir, loadEnv, ROOT } from "./demo-lib.mjs";
import { serveLocal } from "./serve-local.mjs";

let failed = 0;
const pass = (what) => console.log(`✅ ${what}`);
const warn = (what) => console.log(`⚠️  ${what}`);
const fail = (what) => { console.log(`❌ ${what}`); failed++; };
const check = async (what, fn) => {
  try {
    const note = await fn();
    if (typeof note === "string" && note.startsWith("WARN:")) warn(`${what} (${note.slice(5).trim()})`);
    else pass(note ? `${what} (${note})` : what);
  } catch (e) {
    fail(`${what}: ${e.message}`);
  }
};
const must = (ok, msg) => { if (!ok) throw new Error(msg); };

const env = loadEnv();
const issue = Number(env.DEMO_ISSUE ?? 1);
const tmpHome = path.join(os.tmpdir(), "tw-preflight-home");

for (const [name, url] of [["main", env.MAIN_URL], ["branch deploy", env.BRANCH_URL]])
  await check(`${name} is up: ${url}`, async () => {
    for (const p of ["/", "/shop", "/cart", "/contact"]) {
      const r = await fetch(url + p);
      must(r.status === 200, `${p} returned ${r.status}`);
    }
  });

await check("dist/ is built and newer than src/", async () => {
  const dist = path.join(ROOT, "dist", "index.js");
  must(fs.existsSync(dist), "dist/index.js is missing, run npm run build");
  const newestSrc = Math.max(...fs.readdirSync(path.join(ROOT, "src")).map((f) => fs.statSync(path.join(ROOT, "src", f)).mtimeMs));
  must(fs.statSync(dist).mtimeMs >= newestSrc, "src/ changed after the last build, run npm run build");
});

await check("Cursor is wired to this build", async () => {
  const file = path.resolve(ROOT, "..", ".cursor", "mcp.json");
  must(fs.existsSync(file), `${file} is missing`);
  const server = JSON.parse(fs.readFileSync(file, "utf8")).mcpServers?.tripwire;
  must(server && fs.existsSync(server.args[0]), "mcp.json does not point at an existing dist/index.js");
  must(path.resolve(server.env.TRIPWIRE_HOME) === path.resolve(env.TRIPWIRE_HOME), "mcp.json and demo.env disagree on TRIPWIRE_HOME");
});

await check("seeded store exists", async () => {
  must(fs.existsSync(env.SEED_HOME), `${env.SEED_HOME} is missing, run node scripts/seed-demo.mjs`);
  copyDir(env.SEED_HOME, tmpHome);
});

let siteId;
const { client, call } = await connect(env, tmpHome);
try {
  await check("MCP server lists 12 tools", async () => {
    const tools = (await client.listTools()).tools;
    must(tools.length === 12, `found ${tools.length}`);
  });

  await check("promises are seeded with a baseline", async () => {
    const sites = (await call("tripwire_history", { limit: 1 })).json.sites;
    must(sites.length === 1, `expected 1 site, found ${sites.length}`);
    siteId = sites[0];
    const list = (await call("tripwire_list_checks", { siteId })).json;
    must(list.baselineRunId, "no baseline");
    must(list.checks.some((c) => c.intent.includes("WELCOME10")), "the WELCOME10 promise is missing");
    return `${list.checks.length} promises, site ${siteId}`;
  });

  await check("Firecrawl key", async () => {
    if (!env.FIRECRAWL_API_KEY) return "WARN: no key, the scan falls back to the built-in browser scanner";
    const r = await fetch(`${env.FIRECRAWL_API_URL ?? "https://api.firecrawl.dev"}/v1/map`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.FIRECRAWL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: env.MAIN_URL, limit: 5 }),
    });
    must(r.ok, `Firecrawl answered ${r.status}`);
    return `${((await r.json()).links ?? []).length} links mapped`;
  });

  await check(`tripwire_read_issue(${issue}) returns the 3 acceptance criteria`, async () => {
    const r = (await call("tripwire_read_issue", { issue })).json;
    must(r.acceptanceCriteria.length === 3, `got ${r.acceptanceCriteria.length}: ${JSON.stringify(r.acceptanceCriteria)}`);
    return r.title;
  });

  await check("GitHub login can create and close an issue", async () => {
    const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const made = JSON.parse(gh("api", `repos/${env.GITHUB_REPO}/issues`, "-f", "title=Preflight check", "-f", "body=Created and closed by scripts/preflight.mjs.", "-f", "labels[]=preflight"));
    gh("api", "-X", "PATCH", `repos/${env.GITHUB_REPO}/issues/${made.number}`, "-f", "state=closed", "-f", "state_reason=not_planned");
    return `#${made.number} created and closed`;
  });

  await check("guard on main says SAFE", async () => {
    const g = (await call("tripwire_guard", { siteId, targetUrl: env.MAIN_URL, label: "preflight main" })).json;
    must(g.verdict === "SAFE", `${g.verdict}: ${g.headline} ${JSON.stringify(g.regressions ?? [])}`);
    return g.headline;
  });

  await check("guard on the branch deploy says BROKEN with €14.49", async () => {
    const r = await call("tripwire_guard", { siteId, targetUrl: env.BRANCH_URL, change: { label: "refactor price helper", issue, files: ["price.js"] } });
    const g = r.json;
    must(g.verdict === "BROKEN", `${g.verdict}: ${g.headline}`);
    must(g.regressions.some((x) => x.detail.includes("€14.49")), `no €14.49 in ${JSON.stringify(g.regressions)}`);
    must(g.regressions.filter((x) => x.kind === "newly_failing").length === 1, "more than one promise broke");
    must(r.images.length === 1, "no screenshot returned");
    return g.headline;
  });

  await check("local fallback: SAFE on :4321, BROKEN on :4322", async () => {
    const servers = await serveLocal(env);
    try {
      const good = (await call("tripwire_guard", { siteId, targetUrl: env.LOCAL_MAIN_URL ?? "http://localhost:4321", label: "preflight local main" })).json;
      must(good.verdict === "SAFE", `:4321 gave ${good.verdict}: ${JSON.stringify(good.regressions ?? [])}`);
      const bad = (await call("tripwire_guard", { siteId, targetUrl: env.LOCAL_BRANCH_URL ?? "http://localhost:4322", label: "preflight local branch" })).json;
      must(bad.verdict === "BROKEN" && bad.regressions.some((x) => x.detail.includes("€14.49")), `:4322 gave ${bad.verdict}`);
    } finally {
      for (const s of servers) s.kill();
    }
  });
} finally {
  await client.close().catch(() => {});
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

await check("shop working copy is on the buggy branch, ready for the fix", async () => {
  const git = (...args) => execFileSync("git", args, { cwd: env.DEMO_SHOP_DIR, encoding: "utf8" }).trim();
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  must(branch === (env.DEMO_BRANCH ?? "refactor-price"), `it is on ${branch}`);
  must(git("status", "--porcelain") === "", "it has uncommitted changes, run node scripts/reset-demo.mjs");
});

await check("reset script restores the store", async () => {
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "reset-demo.mjs"), "--store-only"], { stdio: "ignore" });
  const sites = path.join(env.TRIPWIRE_HOME, "sites");
  const site = fs.readdirSync(sites)[0];
  const runs = fs.readdirSync(path.join(sites, site, "runs"));
  must(fs.existsSync(path.join(sites, site, "baseline.json")) && runs.length === 1, `expected the baseline and 1 run, found ${runs.length} runs`);
});

console.log(failed ? `\n${failed} check(s) failed. Not ready.` : "\nAll green. Ready to demo.");
process.exit(failed ? 1 : 0);
