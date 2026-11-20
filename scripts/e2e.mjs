// End-to-end: good build -> baseline; broken build -> guard must say BROKEN; the regression is filed
// on a mock GitHub API and linked to the issue whose change caused it. Exits non-zero if anything is off.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const HOME = path.join(os.tmpdir(), "tw-e2e-home");
fs.rmSync(HOME, { recursive: true, force: true });

let failures = 0;
const expect = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures++; };

const start = (broken, port) => new Promise((r) => {
  const p = spawn("node", ["demo/serve.mjs"], { env: { ...process.env, PORT: String(port), BROKEN: broken ? "1" : "0" } });
  p.stdout.once("data", () => r(p));
});
const good = await start(false, 4321);
const bad = await start(true, 4322);

// Mock GitHub API: issue #12 is the change being made; new issues start at #13.
const gh = { created: [], comments: [] };
const mock = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    const body = raw ? JSON.parse(raw) : {};
    if (req.method === "GET" && req.url === "/repos/demo/shop/issues/12")
      return send(200, {
        number: 12, title: "Refactor the price helper", state: "open", html_url: "https://example.test/demo/shop/issues/12", labels: [],
        body: "Tidy up price.js.\n\n## Acceptance criteria\n- [ ] WELCOME10 still takes 10% off\n- [ ] Cart total updates when adding items\n- [ ] No visual change on the cart page\n\n## Notes\n- not a criterion",
      });
    if (req.method === "POST" && req.url === "/repos/demo/shop/issues") {
      gh.created.push(body);
      return send(201, { number: 13, html_url: "https://example.test/demo/shop/issues/13" });
    }
    if (req.method === "POST" && req.url === "/repos/demo/shop/issues/12/comments") {
      gh.comments.push(body);
      return send(201, { html_url: "https://example.test/demo/shop/issues/12#comment-1" });
    }
    send(404, { message: "not found" });
  });
});
await new Promise((r) => mock.listen(4399, r));

const client = new Client({ name: "e2e", version: "0" });
await client.connect(new StdioClientTransport({
  command: "node", args: ["dist/index.js"], stderr: "ignore",
  // No GITHUB_REPO: the repo is saved with the site when it is scanned.
  env: { ...process.env, TRIPWIRE_HOME: HOME, FIRECRAWL_API_KEY: "", GITHUB_API_URL: "http://localhost:4399", GITHUB_TOKEN: "test-token", GITHUB_REPO: "" },
}));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content.find((c) => c.type === "text")?.text ?? "";
  if (r.isError) throw new Error(name + ": " + t);
  try { return { json: JSON.parse(t), images: r.content.filter((c) => c.type === "image").length }; } catch { return { json: t, images: 0 }; }
};

try {
  const tools = (await client.listTools()).tools.map((t) => t.name);
  expect(tools.length === 12 && tools.includes("tripwire_read_issue") && !tools.some((t) => /ticket|jira/i.test(t)), `12 tools, GitHub only: ${tools.join(", ")}`);

  const scan = (await call("tripwire_scan_site", { url: "http://localhost:4321", maxPages: 10, repo: "demo/shop" })).json;
  expect(scan.pages.length === 4 && scan.repo === "demo/shop", `scan (${scan.scanner}) found ${scan.pages.map((p) => p.path).join(" ")}, repo ${scan.repo}`);
  const sug = (await call("tripwire_suggest_checks", { siteId: scan.siteId })).json;
  expect(sug.suggestions.length >= 5, `${sug.suggestions.length} suggestions`);

  // The issue's acceptance criteria are readable, so they can become checks.
  const issue = (await call("tripwire_read_issue", { issue: 12, siteId: scan.siteId })).json;
  expect(issue.acceptanceCriteria.length === 3, `read issue #12: ${issue.acceptanceCriteria.length} acceptance criteria`);

  // The nav suggestion as drafted, plus the promise an owner would describe in words.
  const nav = sug.suggestions.find((s) => s.name.startsWith("Main navigation"));
  await call("tripwire_add_check", { siteId: scan.siteId, name: nav.name, intent: nav.intent, steps: nav.draftSteps, priority: "high" });
  await call("tripwire_add_check", {
    siteId: scan.siteId, name: "Discount code WELCOME10 takes 10% off", priority: "critical",
    intent: "If I add the Yirgacheffe and use WELCOME10, the total should be €13.05",
    stakes: "New customers pay full price and stop trusting the shop.",
    steps: [
      { action: "goto", path: "/shop" }, { action: "click", selector: "[data-testid=add-0]" },
      { action: "expectVisible", text: "Added to cart" }, { action: "goto", path: "/cart" },
      { action: "fill", selector: "#code", value: "WELCOME10" }, { action: "click", selector: "[data-testid=apply]" },
      { action: "expectText", selector: "[data-testid=total]", contains: "€13.05" },
    ],
  });
  const contact = sug.suggestions.find((s) => s.name.startsWith("Contact"));
  await call("tripwire_add_check", { siteId: scan.siteId, name: contact.name, intent: contact.intent, steps: contact.draftSteps, priority: "high" });
  const vars = { NAME: "Ana", EMAIL: "ana@example.com", MESSAGE: "Hi!", CONFIRMATION_TEXT: "Thanks" };

  const g1 = (await call("tripwire_guard", { siteId: scan.siteId, label: "main", vars })).json;
  expect(g1.verdict === "BASELINE_SET", `guard on the good build: ${g1.verdict} - ${g1.headline}`);

  const g2 = await call("tripwire_guard", {
    siteId: scan.siteId, targetUrl: "http://localhost:4322", vars,
    change: { label: "refactor price helper", issue: 12, files: ["price.js"] },
  });
  expect(g2.json.verdict === "BROKEN", `guard on the broken build: ${g2.json.verdict}`);
  expect(g2.json.headline.includes("€13.05") && g2.json.headline.includes("At stake"), `headline: ${g2.json.headline}`);
  expect(g2.json.regressions.some((r) => r.detail.includes("€14.49")), `detail: ${g2.json.regressions[0]?.detail}`);
  expect(g2.images === 1, `failing screenshot returned inline (${g2.images})`);
  expect(fs.existsSync(g2.json.report), `report written: ${g2.json.report}`);

  // No runId, checkId or linkTo: the latest run, its failing check and the change's issue are used.
  const filed = (await call("tripwire_file_issue", { siteId: scan.siteId })).json;
  expect(filed.issue === 13 && filed.linkedTo === 12, `filed #${filed.issue}, linked to #${filed.linkedTo}`);
  const body = gh.created[0]?.body ?? "";
  expect(body.includes("**Promise:**") && body.includes("**What is at stake:**") && body.includes("fails here"), "issue has the promise, the stakes and the failing step");
  expect(body.includes('Type "WELCOME10" into the "Discount code" field'), "steps to reproduce are in plain words");
  expect(gh.comments.length === 1 && gh.comments[0].body.includes("#13"), "commented on #12 pointing at #13");

  const hist = (await call("tripwire_history", { siteId: scan.siteId, limit: 20 })).json;
  expect(hist.runs.length === 2, `history: ${hist.runs.length} runs, ${hist.audit.length} audit entries`);
  const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
  expect(prompts.includes("guard_my_app") && prompts.includes("verify_issue"), `prompts: ${prompts.join(", ")}`);
} catch (e) {
  expect(false, `threw: ${e.message}`);
} finally {
  await client.close().catch(() => {});
  good.kill(); bad.kill(); mock.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall good");
process.exit(failures ? 1 : 0);
