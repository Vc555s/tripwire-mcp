#!/usr/bin/env node
// Tripwire MCP server: plain-English regression guarding for web apps.
// The editor's agent is the "brain" (turns intent into steps); Tripwire is the hands and the memory
// (crawls, runs a real browser, keeps baselines, diffs, reports, files issues). No LLM key needed.

import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { audit, readAudit } from "./audit.js";
import { scanSite } from "./crawl.js";
import { suggestChecks } from "./suggest.js";
import { runChecks } from "./runner.js";
import { compareRuns } from "./compare.js";
import { writeReport } from "./report.js";
import { fileIssue, readIssue } from "./issues.js";
import { HOME, newId, store } from "./store.js";
import type { Change, Check, Step } from "./types.js";

const server = new McpServer({ name: "tripwire", version: "0.1.0" });

// ---------- schemas ----------
const StepSchema = z.object({
  action: z.enum([
    "goto", "click", "fill", "select", "press", "wait",
    "expectVisible", "expectNotVisible", "expectText", "expectUrlContains", "expectCount",
  ]),
  path: z.string().optional().describe("goto: path relative to the site, e.g. /cart"),
  selector: z.string().optional().describe("CSS/Playwright selector. Prefer selectors returned by tripwire_scan_site."),
  text: z.string().optional().describe("click/expectVisible: visible text to find instead of a selector"),
  value: z.string().optional().describe("fill/select value, or expectUrlContains value. {{VAR}} placeholders allowed."),
  key: z.string().optional().describe("press: key name, e.g. Enter"),
  contains: z.string().optional().describe("expectText: substring the element must contain"),
  count: z.number().int().optional().describe("expectCount: exact number of matches"),
  ms: z.number().int().optional().describe("wait: milliseconds (max 15000)"),
});

function toStep(s: z.infer<typeof StepSchema>): Step {
  const need = (k: keyof typeof s) => {
    if (s[k] === undefined) throw new Error(`Step "${s.action}" needs "${String(k)}".`);
    return s[k] as never;
  };
  switch (s.action) {
    case "goto": return { action: "goto", path: need("path") };
    case "click": if (!s.selector && !s.text) need("selector"); return { action: "click", selector: s.selector, text: s.text };
    case "fill": return { action: "fill", selector: need("selector"), value: need("value") };
    case "select": return { action: "select", selector: need("selector"), value: need("value") };
    case "press": return { action: "press", key: need("key"), selector: s.selector };
    case "wait": return { action: "wait", ms: need("ms") };
    case "expectVisible": if (!s.selector && !s.text) need("selector"); return { action: "expectVisible", selector: s.selector, text: s.text };
    case "expectNotVisible": if (!s.selector && !s.text) need("selector"); return { action: "expectNotVisible", selector: s.selector, text: s.text };
    case "expectText": return { action: "expectText", selector: need("selector"), contains: need("contains") };
    case "expectUrlContains": return { action: "expectUrlContains", value: need("value") };
    case "expectCount": return { action: "expectCount", selector: need("selector"), count: need("count") };
  }
}

// ---------- helpers ----------
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function wrap<A>(name: string, fn: (args: A) => Promise<Content[] | object>) {
  return async (args: A) => {
    try {
      const out = await fn(args);
      audit(name, args, "ok");
      const content: Content[] = Array.isArray(out) ? out : [{ type: "text", text: JSON.stringify(out, null, 2) }];
      return { content };
    } catch (e) {
      const msg = (e as Error).message;
      audit(name, args, "error", msg);
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
    }
  };
}

function screenshotContent(siteId: string, runId: string, file?: string): Content[] {
  if (!file) return [];
  const p = path.join(store.runDir(siteId, runId), file);
  return fs.existsSync(p) ? [{ type: "image", data: fs.readFileSync(p).toString("base64"), mimeType: "image/png" }] : [];
}

const siteId = z.string().describe("Site id returned by tripwire_scan_site (tripwire_history lists known sites)");

const ChangeSchema = z
  .object({
    label: z.string().optional().describe("Short description of the change, e.g. 'refactor price helper' or a commit sha"),
    issue: z.number().int().optional().describe("GitHub issue number this change is for, so a break can be traced back to it"),
    files: z.array(z.string()).optional().describe("Files the change touched"),
  })
  .optional()
  .describe("The code change being checked. Recorded on the run and used to link a regression to its cause.");

// ---------- tools ----------
server.registerTool(
  "tripwire_scan_site",
  {
    title: "Scan a site",
    description:
      "Crawl a website (local dev server, preview deploy or production) and map its pages, links, buttons, inputs and forms, " +
      "with selectors Tripwire can use. Run this first for any new site. Uses Firecrawl for discovery when FIRECRAWL_API_KEY is set.",
    inputSchema: {
      url: z.string().url().describe("Base URL, e.g. http://localhost:3000 or https://my-app.netlify.app"),
      maxPages: z.number().int().min(1).max(50).default(15),
      repo: z.string().optional().describe('GitHub repo the site\'s code lives in, as "owner/repo". Issues for this site are read and filed there.'),
    },
  },
  wrap("tripwire_scan_site", async ({ url, maxPages, repo }: { url: string; maxPages: number; repo?: string }) => {
    const site = await scanSite(url, maxPages);
    let previous: string | undefined;
    try { previous = store.getSite(site.id).repo; } catch { /* first scan of this site */ }
    site.repo = repo ?? previous;
    store.saveSite(site);
    return {
      siteId: site.id,
      repo: site.repo,
      scanner: site.scanner,
      pages: site.pages.map((p) => ({
        path: p.path,
        title: p.title,
        headings: p.headings.slice(0, 3),
        buttons: p.buttons.slice(0, 12),
        inputs: p.inputs.slice(0, 12),
        forms: p.forms,
        links: p.links.slice(0, 15).map((l) => `${l.text} -> ${l.href}`),
      })),
      next: "Call tripwire_suggest_checks, or turn the user's plain-English expectations into checks with tripwire_add_check.",
    };
  }),
);

server.registerTool(
  "tripwire_suggest_checks",
  {
    title: "Suggest what to guard",
    description:
      "Suggest the checks a non-technical owner would care about (pages load, login, sign-up, search, cart, checkout, " +
      "contact form, navigation), ranked by business impact, with draft steps. Show these to the user in plain language " +
      "and ask which to guard; replace {{PLACEHOLDERS}} with real values or leave them for run-time vars.",
    inputSchema: { siteId },
  },
  wrap("tripwire_suggest_checks", async ({ siteId }: { siteId: string }) => {
    const s = suggestChecks(store.getSite(siteId));
    return { count: s.length, suggestions: s };
  }),
);

server.registerTool(
  "tripwire_add_check",
  {
    title: "Guard something",
    description:
      "Save a check: something that must keep working. Translate the user's plain-English intent into steps using " +
      "selectors from tripwire_scan_site (prefer data-testid, id, name, aria-label; use visible text when unsure). " +
      "Every check should end with at least one expect* step, otherwise it proves nothing. Keep the user's intent verbatim, " +
      "and ask what it would cost them if this broke: that answer is the stakes.",
    inputSchema: {
      siteId,
      name: z.string().describe("Short name, e.g. 'Checkout applies discount code'"),
      intent: z.string().describe("The user's own words for what must keep working"),
      stakes: z.string().optional().describe("What it costs the user if this breaks, in their words, e.g. 'new customers pay full price'"),
      steps: z.array(StepSchema).min(1),
      priority: z.enum(["critical", "high", "normal"]).default("normal"),
      issue: z.number().int().optional().describe("GitHub issue this check comes from, for traceability"),
      replaceCheckId: z.string().optional().describe("Update an existing check instead of adding a new one"),
    },
  },
  wrap("tripwire_add_check", async (a: {
    siteId: string; name: string; intent: string; stakes?: string; steps: z.infer<typeof StepSchema>[];
    priority: Check["priority"]; issue?: number; replaceCheckId?: string;
  }) => {
    store.getSite(a.siteId);
    const steps = a.steps.map(toStep);
    if (!steps.some((s) => s.action.startsWith("expect")))
      throw new Error("A check needs at least one expect* step, otherwise it can never fail.");
    const checks = store.getChecks(a.siteId);
    const check: Check = {
      id: a.replaceCheckId ?? newId("chk"),
      name: a.name,
      intent: a.intent,
      steps,
      priority: a.priority,
      createdAt: new Date().toISOString(),
      stakes: a.stakes,
      source: a.issue ? { githubIssue: a.issue } : undefined,
    };
    const idx = checks.findIndex((c) => c.id === check.id);
    if (idx >= 0) checks[idx] = check;
    else checks.push(check);
    store.saveChecks(a.siteId, checks);
    return { saved: check.id, totalChecks: checks.length, tip: "Run tripwire_run to verify it passes on the current version." };
  }),
);

server.registerTool(
  "tripwire_list_checks",
  {
    title: "List guarded checks",
    description: "List everything Tripwire is guarding for a site, with the user's original intent.",
    inputSchema: { siteId },
  },
  wrap("tripwire_list_checks", async ({ siteId }: { siteId: string }) => ({
    site: store.getSite(siteId).baseUrl,
    repo: store.getSite(siteId).repo,
    baselineRunId: store.getBaseline(siteId),
    checks: store.getChecks(siteId).map((c) => ({ id: c.id, name: c.name, priority: c.priority, intent: c.intent, stakes: c.stakes, steps: c.steps.length, source: c.source })),
  })),
);

server.registerTool(
  "tripwire_remove_check",
  {
    title: "Stop guarding a check",
    description: "Remove a check. Use when the user says a behaviour changed on purpose.",
    inputSchema: { siteId, checkId: z.string() },
  },
  wrap("tripwire_remove_check", async ({ siteId, checkId }: { siteId: string; checkId: string }) => {
    const before = store.getChecks(siteId);
    store.saveChecks(siteId, before.filter((c) => c.id !== checkId));
    return { removed: before.length - store.getChecks(siteId).length };
  }),
);

server.registerTool(
  "tripwire_run",
  {
    title: "Run checks",
    description:
      "Run checks in a real browser and record evidence (screenshots, console errors, failed requests). " +
      "Use targetUrl to test a different deployment of the same site, e.g. a Netlify deploy preview.",
    inputSchema: {
      siteId,
      targetUrl: z.string().url().optional(),
      label: z.string().optional().describe("e.g. 'before change', 'PR #42', commit sha"),
      checkIds: z.array(z.string()).optional(),
      vars: z.record(z.string(), z.string()).optional().describe("Values for {{PLACEHOLDERS}}, e.g. {TEST_EMAIL: 'a@b.c'}"),
      change: ChangeSchema,
    },
  },
  wrap("tripwire_run", async (a: { siteId: string; targetUrl?: string; label?: string; checkIds?: string[]; vars?: Record<string, string>; change?: Change }) => {
    const run = await runChecks(a);
    const report = writeReport(a.siteId, run);
    return {
      runId: run.id,
      summary: run.summary,
      failures: run.results.filter((r) => !r.passed).map((r) => ({ checkId: r.checkId, name: r.name, step: (r.failedStep ?? 0) + 1, error: r.error })),
      report,
      next: store.getBaseline(a.siteId) ? "Call tripwire_compare to see what changed vs the baseline." : "If this version is known-good, call tripwire_set_baseline.",
    };
  }),
);

server.registerTool(
  "tripwire_set_baseline",
  {
    title: "Mark as known-good",
    description: "Mark a run as the known-good baseline future runs are compared against.",
    inputSchema: { siteId, runId: z.string() },
  },
  wrap("tripwire_set_baseline", async ({ siteId, runId }: { siteId: string; runId: string }) => {
    const run = store.getRun(siteId, runId);
    if (run.summary.failed) throw new Error(`Run ${runId} has ${run.summary.failed} failing check(s). Fix or remove them before using it as a baseline.`);
    store.setBaseline(siteId, runId);
    return { baseline: runId };
  }),
);

server.registerTool(
  "tripwire_compare",
  {
    title: "What changed?",
    description:
      "Compare a run with the baseline: newly failing checks, new browser errors, new failing requests, slowdowns and " +
      "visual changes. Returns a verdict (SAFE / CHANGED / BROKEN), a plain-language headline and an HTML report.",
    inputSchema: { siteId, runId: z.string(), baselineRunId: z.string().optional() },
  },
  wrap("tripwire_compare", async ({ siteId, runId, baselineRunId }: { siteId: string; runId: string; baselineRunId?: string }) => {
    const cmp = compareRuns(siteId, runId, baselineRunId);
    const report = writeReport(siteId, store.getRun(siteId, runId), cmp);
    const first = cmp.regressions.find((r) => r.kind === "newly_failing");
    const shot = first ? store.getRun(siteId, runId).results.find((r) => r.checkId === first.checkId)?.screenshot : undefined;
    return [{ type: "text", text: JSON.stringify({ ...cmp, report }, null, 2) }, ...screenshotContent(siteId, runId, shot)];
  }),
);

server.registerTool(
  "tripwire_guard",
  {
    title: "Did I break anything?",
    description:
      "One call after any code change: runs every guarded check, compares with the baseline and returns a verdict with " +
      "evidence. If there is no baseline yet and everything passes, this run becomes the baseline. " +
      "Call this after editing code that affects the UI, before committing or deploying. Pass `change` (what was changed and " +
      "the issue it is for) so a broken promise can be traced to its cause.",
    inputSchema: {
      siteId,
      targetUrl: z.string().url().optional().describe("Another deployment of the same site to check, e.g. a deploy preview"),
      label: z.string().optional(),
      vars: z.record(z.string(), z.string()).optional(),
      change: ChangeSchema,
    },
  },
  wrap("tripwire_guard", async (a: { siteId: string; targetUrl?: string; label?: string; vars?: Record<string, string>; change?: Change }) => {
    const run = await runChecks({ ...a, label: a.label ?? a.change?.label ?? "guard" });
    if (!store.getBaseline(a.siteId)) {
      if (run.summary.failed === 0) {
        store.setBaseline(a.siteId, run.id);
        const report = writeReport(a.siteId, run);
        return { verdict: "BASELINE_SET", headline: `All ${run.summary.total} checks pass. Saved as the known-good baseline.`, runId: run.id, report };
      }
      const report = writeReport(a.siteId, run);
      return {
        verdict: "NO_BASELINE",
        headline: `${run.summary.failed} check(s) fail on this version, so it can't be the baseline yet.`,
        failures: run.results.filter((r) => !r.passed).map((r) => ({ name: r.name, error: r.error })),
        report,
      };
    }
    const cmp = compareRuns(a.siteId, run.id);
    const report = writeReport(a.siteId, run, cmp);
    const first = cmp.regressions.find((r) => r.kind === "newly_failing");
    const shot = first ? run.results.find((r) => r.checkId === first.checkId)?.screenshot : undefined;
    return [
      { type: "text", text: JSON.stringify({ ...cmp, runId: run.id, report }, null, 2) },
      ...screenshotContent(a.siteId, run.id, shot),
    ];
  }),
);

server.registerTool(
  "tripwire_file_issue",
  {
    title: "Report a regression",
    description:
      "File a failing check as a GitHub issue with the user's promise, what is at stake, steps to reproduce in plain words " +
      "and the errors. Also comments on the issue whose change caused it (linkTo, or the issue recorded on the run).",
    inputSchema: {
      siteId,
      runId: z.string().optional().describe("Defaults to the latest run"),
      checkId: z.string().optional().describe("Defaults to the first failing check in the run"),
      linkTo: z.number().int().optional().describe("Issue number of the change that caused this. Defaults to the run's change.issue"),
      repo: z.string().optional().describe('"owner/repo". Defaults to the repo saved with the site'),
    },
  },
  wrap("tripwire_file_issue", async (a: { siteId: string; runId?: string; checkId?: string; linkTo?: number; repo?: string }) =>
    fileIssue(a.siteId, a.runId, a.checkId, a.linkTo, a.repo),
  ),
);

server.registerTool(
  "tripwire_read_issue",
  {
    title: "Read a GitHub issue",
    description:
      "Fetch a GitHub issue and extract its acceptance criteria (checklist or bullets) so they can be turned into checks, " +
      "and so regressions can be linked back to the change that caused them.",
    inputSchema: {
      issue: z.number().int().describe("Issue number, e.g. 1"),
      siteId: z.string().optional().describe("Site whose repo the issue is in"),
      repo: z.string().optional().describe('"owner/repo". Defaults to the site\'s repo'),
    },
  },
  wrap("tripwire_read_issue", async ({ issue, siteId, repo }: { issue: number; siteId?: string; repo?: string }) => readIssue(issue, siteId, repo)),
);

server.registerTool(
  "tripwire_history",
  {
    title: "Run history and audit log",
    description: "Recent runs for a site and the audit trail of Tripwire actions.",
    inputSchema: { siteId: z.string().optional(), limit: z.number().int().min(1).max(200).default(20) },
  },
  wrap("tripwire_history", async ({ siteId, limit }: { siteId?: string; limit: number }) => ({
    home: HOME,
    sites: store.listSites(),
    runs: siteId ? store.listRuns(siteId).slice(-limit).map((r) => ({ id: r.id, label: r.label, at: r.startedAt, target: r.targetUrl, ...r.summary })) : undefined,
    audit: readAudit(limit),
  })),
);

// ---------- prompts (show up as slash commands in many clients) ----------
server.registerPrompt(
  "guard_my_app",
  {
    title: "Guard my app",
    description: "Set up regression guarding for a site in plain English.",
    argsSchema: { url: z.string().describe("Your app's URL") },
  },
  ({ url }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text:
          `Set up Tripwire for ${url}. 1) tripwire_scan_site. 2) tripwire_suggest_checks and show me the suggestions as a short ` +
          `plain-English list, most important first. 3) Ask me which to guard, what else must never break, and what it would ` +
          `cost me if each one broke. 4) Save them with tripwire_add_check, keeping my words as the intent and the cost as the ` +
          `stakes. 5) tripwire_guard to set the baseline. Explain results without jargon.`,
      },
    }],
  }),
);

server.registerPrompt(
  "verify_issue",
  {
    title: "Verify a GitHub issue",
    description: "Turn an issue's acceptance criteria into checks, run them and guard against regressions.",
    argsSchema: { issue: z.string().describe("Issue number"), siteId: z.string() },
  },
  ({ issue, siteId }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text:
          `Read issue #${issue} with tripwire_read_issue. Turn each acceptance criterion into a check on site ${siteId} ` +
          `(tripwire_add_check, issue=${issue}). Then tripwire_guard with change.issue=${issue}. If anything that used to ` +
          `work now fails, offer to fix it and to file it with tripwire_file_issue, which links it to #${issue}.`,
      },
    }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`Tripwire MCP running (data: ${HOME})`);
