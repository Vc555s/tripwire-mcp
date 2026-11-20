// Tripwire on a real project of your own: the live site is the baseline, and a local working copy
// (served on localhost, nothing pushed) is the changed build.
//   node scripts/site-demo.mjs <profile> serve     serve the working copy on DEMO_PORT (leave it running)
//   node scripts/site-demo.mjs <profile> seed      scan the live site, save the promises, set the baseline
//   node scripts/site-demo.mjs <profile> reset     back to the starting state (store, working copy, GitHub)
//   node scripts/site-demo.mjs <profile> rehearse  reset -> BROKEN -> file the issue -> fix -> SAFE -> reset
// Settings come from demo.<profile>.env and the promises from the JSON file it names (both git-ignored).
// Only this site's folder in the store is touched, so other guarded sites keep their data.
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { connect, copyDir, loadEnv, ROOT } from "./demo-lib.mjs";

const [profile, command] = process.argv.slice(2);
if (!profile || !["serve", "seed", "reset", "rehearse"].includes(command)) {
  console.error("usage: node scripts/site-demo.mjs <profile> serve|seed|reset|rehearse");
  process.exit(1);
}
const env = loadEnv(profile);
for (const k of ["SITE_ID", "DEMO_DIR", "DEMO_BRANCH", "DEMO_RESET_REF", "DEMO_FIX", "DEMO_PORT", "PROMISES"]) if (!env[k]) throw new Error(`demo.${profile}.env is missing ${k}.`);
const repo = env.GITHUB_REPO;
const issue = Number(env.DEMO_ISSUE ?? 1);
const files = (env.CHANGE_FILES ?? "").split(",").map((f) => f.trim()).filter(Boolean);
const liveDir = path.join(env.TRIPWIRE_HOME, "sites", env.SITE_ID);
const seedDir = path.join(env.SEED_HOME, "sites", env.SITE_ID);
const git = (cmd) => execSync(`git ${cmd}`, { cwd: env.DEMO_DIR, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const step = (n, what) => console.log(`\n[${n}] ${what}`);

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".pdf": "application/pdf", ".woff2": "font/woff2", ".xml": "application/xml", ".txt": "text/plain" };
/** Serves the working copy as a plain static site. Resolves to the server, or null if the port is already serving. */
function serve() {
  const root = path.resolve(env.DEMO_DIR);
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (rel.endsWith("/")) rel += "index.html";
    let file = path.join(root, rel);
    if (!file.startsWith(root) || rel.includes("/.git")) { res.writeHead(403).end(); return; }
    if (!fs.existsSync(file) && fs.existsSync(`${file}.html`)) file += ".html";
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { "content-type": "text/plain" }).end("Not found"); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once("error", (e) => (e.code === "EADDRINUSE" ? resolve(null) : reject(e)));
    server.listen(Number(env.DEMO_PORT), () => resolve(server));
  });
}

function reset() {
  if (!fs.existsSync(seedDir)) throw new Error(`No seed at ${seedDir}. Run: node scripts/site-demo.mjs ${profile} seed`);
  copyDir(seedDir, liveDir);
  console.log(`store restored: ${liveDir}`);
  git(`checkout -q ${env.DEMO_BRANCH}`);
  git(`reset -q --hard ${env.DEMO_RESET_REF}`);
  console.log(`working copy: ${env.DEMO_BRANCH} at ${git("log --oneline -1")}`);
  const open = JSON.parse(gh("issue", "list", "--repo", repo, "--label", "tripwire", "--state", "open", "--json", "number"));
  for (const { number } of open) gh("issue", "close", String(number), "--repo", repo, "--reason", "not planned", "--comment", "Closed by the demo reset.");
  const comments = JSON.parse(gh("api", `repos/${repo}/issues/${issue}/comments`, "--paginate"));
  const mine = comments.filter((c) => c.body.startsWith("Tripwire:"));
  for (const c of mine) gh("api", "-X", "DELETE", `repos/${repo}/issues/comments/${c.id}`);
  console.log(`GitHub: closed ${open.length} regression issue(s), removed ${mine.length} Tripwire comment(s) from #${issue}`);
}

async function seed() {
  const promises = JSON.parse(fs.readFileSync(path.resolve(ROOT, env.PROMISES), "utf8"));
  fs.rmSync(liveDir, { recursive: true, force: true });
  const { client, call } = await connect(env);
  try {
    const scan = (await call("tripwire_scan_site", { url: env.MAIN_URL, maxPages: 10, repo })).json;
    if (scan.siteId !== env.SITE_ID) throw new Error(`SITE_ID should be ${scan.siteId}`);
    console.log(`scanned ${env.MAIN_URL} with ${scan.scanner}: ${scan.pages.map((p) => p.path).join(" ")}`);
    for (const p of promises) await call("tripwire_add_check", { siteId: scan.siteId, ...p });
    const guard = (await call("tripwire_guard", { siteId: scan.siteId, label: "live site, known good" })).json;
    console.log(`${guard.verdict}: ${guard.headline}`);
    if (guard.verdict !== "BASELINE_SET") throw new Error(`Expected BASELINE_SET, got ${guard.verdict}: ${JSON.stringify(guard.failures ?? guard.regressions ?? guard)}`);
  } finally {
    await client.close().catch(() => {});
  }
  copyDir(liveDir, seedDir);
  console.log(`${promises.length} promises saved for ${env.SITE_ID}\nseed: ${seedDir}`);
}

async function rehearse() {
  const out = path.resolve(env.EVIDENCE_DIR ?? path.join(ROOT, "..", "demo-evidence", profile));
  step(0, "reset");
  reset();
  fs.mkdirSync(out, { recursive: true });
  const own = await serve();
  console.log(own ? `serving ${env.DEMO_DIR} on ${env.BRANCH_URL} for this rehearsal` : `${env.BRANCH_URL} is already being served`);
  const { client, call } = await connect(env);
  const siteId = env.SITE_ID;
  let ok = false;
  try {
    step(1, "the promises, in the owner's words");
    const listed = (await call("tripwire_list_checks", { siteId })).json;
    for (const c of listed.checks) console.log(`  ${c.priority.padEnd(8)} ${c.intent}`);
    if (listed.repo !== repo) throw new Error(`site repo is ${listed.repo}, expected ${repo}`);

    step(2, `read issue #${issue}`);
    const read = (await call("tripwire_read_issue", { issue, siteId })).json;
    console.log(`  ${read.title}: ${read.acceptanceCriteria.length} acceptance criteria`);

    step(3, `guard the local change for #${issue}`);
    const broken = await call("tripwire_guard", { siteId, targetUrl: env.BRANCH_URL, change: { label: env.CHANGE_LABEL ?? "local change", issue, files } });
    console.log(`  ${broken.json.verdict}: ${broken.json.headline}`);
    for (const r of broken.json.regressions ?? []) console.log(`  ${r.kind}: ${r.detail}`);
    if (broken.json.verdict !== "BROKEN") throw new Error("expected BROKEN");
    fs.copyFileSync(broken.json.report, path.join(out, "report-broken.html"));
    if (broken.images[0]) fs.writeFileSync(path.join(out, "screenshot-broken.png"), Buffer.from(broken.images[0].data, "base64"));
    fs.writeFileSync(path.join(out, "verdict-broken.json"), JSON.stringify(broken.json, null, 2));

    step(4, "file it");
    const filed = (await call("tripwire_file_issue", { siteId })).json;
    console.log(`  filed #${filed.issue} in ${filed.repo}: ${filed.url}\n  comment on #${filed.linkedTo}: ${filed.comment}`);
    if (filed.repo !== repo || !filed.comment?.startsWith("http")) throw new Error(`issue not filed as expected: ${JSON.stringify(filed)}`);

    step(5, `fix it: git ${env.DEMO_FIX}`);
    git(env.DEMO_FIX);

    step(6, "guard again");
    const safe = (await call("tripwire_guard", { siteId, targetUrl: env.BRANCH_URL, change: { label: "fix", issue, files } })).json;
    console.log(`  ${safe.verdict}: ${safe.headline}`);
    if (safe.verdict !== "SAFE") throw new Error(`expected SAFE, got ${safe.verdict}: ${JSON.stringify(safe.regressions)}`);
    fs.copyFileSync(safe.report, path.join(out, "report-safe.html"));

    fs.writeFileSync(path.join(out, "README.md"), [
      `# Demo evidence: ${env.MAIN_URL}`,
      "",
      `Captured ${new Date().toISOString()} by \`scripts/site-demo.mjs ${profile} rehearse\` against the live site, a local working copy and the real GitHub repo.`,
      "Open these if the live demo cannot run.",
      "",
      "- `report-broken.html`: the BROKEN report for the local change",
      "- `screenshot-broken.png`: the screenshot the agent shows in chat",
      "- `verdict-broken.json`: the exact verdict returned to the agent",
      "- `report-safe.html`: the SAFE report after the fix",
      `- Regression issue filed by Tripwire: ${filed.url} (closed by the reset; the page still shows it)`,
      `- The issue that caused it: https://github.com/${repo}/issues/${issue}`,
      "",
    ].join("\n"));
    ok = true;
  } catch (e) {
    console.error(`\nrehearsal failed: ${e.message}`);
  } finally {
    await client.close().catch(() => {});
    step(7, "reset");
    reset();
    own?.close();
  }
  console.log(ok ? `\nRehearsal passed. Evidence in ${out}` : "\nRehearsal FAILED.");
  process.exit(ok ? 0 : 1);
}

if (command === "serve") {
  const server = await serve();
  console.log(server ? `serving ${env.DEMO_DIR} on ${env.BRANCH_URL} (Ctrl+C to stop)` : `port ${env.DEMO_PORT} is already in use; ${env.BRANCH_URL} is probably being served already`);
} else if (command === "seed") {
  await seed();
} else if (command === "reset") {
  reset();
  console.log("ready");
} else {
  await rehearse();
}
