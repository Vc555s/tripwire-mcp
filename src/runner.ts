// Executes checks in a real browser and records evidence: per-step results, a screenshot,
// console errors and failed network requests. Evidence is what makes a report trustworthy
// to someone who didn't write the test.

import path from "node:path";
import type { Page } from "playwright-core";
import { getBrowser } from "./browser.js";
import type { Change, Check, CheckResult, Run, Step } from "./types.js";
import { newId, store } from "./store.js";

const STEP_TIMEOUT = Number(process.env.TRIPWIRE_STEP_TIMEOUT_MS ?? 8000);

/** {{VAR}} placeholders resolve from run vars, then TRIPWIRE_VAR_<NAME> env vars. */
function fill(value: string, vars: Record<string, string>): string {
  return value.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    const v = vars[k] ?? process.env[`TRIPWIRE_VAR_${k}`];
    if (v === undefined) throw new Error(`Missing value for {{${k}}}. Pass it in "vars" or set TRIPWIRE_VAR_${k}.`);
    return v;
  });
}

function locate(page: Page, s: { selector?: string; text?: string }) {
  if (s.selector) return page.locator(s.selector).first();
  if (s.text) return page.getByText(s.text, { exact: false }).first();
  throw new Error("Step needs a selector or text.");
}

async function exec(page: Page, base: string, step: Step, vars: Record<string, string>) {
  const f = (v: string) => fill(v, vars);
  switch (step.action) {
    case "goto":
      await page.goto(new URL(f(step.path), base).toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      return;
    case "click":
      await locate(page, { selector: step.selector && f(step.selector), text: step.text && f(step.text) }).click({ timeout: STEP_TIMEOUT });
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      return;
    case "fill":
      await page.locator(f(step.selector)).first().fill(f(step.value), { timeout: STEP_TIMEOUT });
      return;
    case "select":
      await page.locator(f(step.selector)).first().selectOption(f(step.value), { timeout: STEP_TIMEOUT });
      return;
    case "press":
      if (step.selector) await page.locator(f(step.selector)).first().press(step.key, { timeout: STEP_TIMEOUT });
      else await page.keyboard.press(step.key);
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      return;
    case "wait":
      await page.waitForTimeout(Math.min(step.ms, 15_000));
      return;
    case "expectVisible":
      await locate(page, { selector: step.selector && f(step.selector), text: step.text && f(step.text) }).waitFor({
        state: "visible",
        timeout: STEP_TIMEOUT,
      });
      return;
    case "expectNotVisible": {
      const loc = locate(page, { selector: step.selector && f(step.selector), text: step.text && f(step.text) });
      await loc.waitFor({ state: "hidden", timeout: STEP_TIMEOUT });
      return;
    }
    case "expectText": {
      const loc = page.locator(f(step.selector)).first();
      await loc.waitFor({ state: "visible", timeout: STEP_TIMEOUT });
      const want = f(step.contains);
      const deadline = Date.now() + STEP_TIMEOUT;
      let got = "";
      while (Date.now() < deadline) {
        got = (await loc.innerText()).trim();
        if (got.includes(want)) return;
        await page.waitForTimeout(200);
      }
      throw new Error(`Expected "${step.selector}" to contain "${want}" but it showed "${got.slice(0, 120)}".`);
    }
    case "expectUrlContains": {
      const want = f(step.value);
      await page.waitForURL((u) => u.toString().includes(want), { timeout: STEP_TIMEOUT }).catch(() => {
        throw new Error(`Expected URL to contain "${want}" but it is "${page.url()}".`);
      });
      return;
    }
    case "expectCount": {
      const want = step.count;
      const deadline = Date.now() + STEP_TIMEOUT;
      let got = -1;
      while (Date.now() < deadline) {
        got = await page.locator(f(step.selector)).count();
        if (got === want) return;
        await page.waitForTimeout(200);
      }
      throw new Error(`Expected ${want} × "${step.selector}" but found ${got}.`);
    }
  }
}

function plainError(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  // Playwright errors are long; keep the first meaningful line for humans.
  return msg.split("\n").find((l) => l.trim())?.replace(/^\w+Error: /, "").slice(0, 300) ?? msg;
}

export async function runChecks(opts: {
  siteId: string;
  targetUrl?: string;
  label?: string;
  checkIds?: string[];
  vars?: Record<string, string>;
  change?: Change;
}): Promise<Run> {
  const site = store.getSite(opts.siteId);
  const base = opts.targetUrl ?? site.baseUrl;
  let checks = store.getChecks(site.id);
  if (opts.checkIds?.length) checks = checks.filter((c) => opts.checkIds!.includes(c.id));
  if (!checks.length) throw new Error("No checks to run. Add some with tripwire_add_check.");

  const run: Run = {
    id: newId("run"),
    siteId: site.id,
    targetUrl: base,
    label: opts.label ?? "manual",
    startedAt: new Date().toISOString(),
    finishedAt: "",
    results: [],
    summary: { total: 0, passed: 0, failed: 0 },
    change: opts.change,
  };
  const dir = store.runDir(site.id, run.id);
  const browser = await getBrowser();

  try {
    for (const check of checks) run.results.push(await runOne(browser, base, check, dir, opts.vars ?? {}));
  } finally {
    await browser.close();
  }

  run.finishedAt = new Date().toISOString();
  run.summary = {
    total: run.results.length,
    passed: run.results.filter((r) => r.passed).length,
    failed: run.results.filter((r) => !r.passed).length,
  };
  store.saveRun(run);
  return run;
}

async function runOne(
  browser: Awaited<ReturnType<typeof getBrowser>>,
  base: string,
  check: Check,
  dir: string,
  vars: Record<string, string>,
): Promise<CheckResult> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 200)));
  page.on("pageerror", (e) => consoleErrors.push(`Uncaught: ${e.message.slice(0, 200)}`));
  // Same-site URLs are stored without the origin, so a deploy preview compares cleanly with the baseline.
  const origin = new URL(base).origin;
  page.on("response", (r) => {
    if (r.status() >= 400) failedRequests.push(`${r.request().method()} ${r.url().replace(origin, "")} -> ${r.status()}`);
  });

  const started = Date.now();
  const steps: CheckResult["steps"] = [];
  let failedStep: number | undefined;
  let error: string | undefined;

  for (const [i, step] of check.steps.entries()) {
    const t = Date.now();
    try {
      await exec(page, base, step, vars);
      steps.push({ index: i, step, ok: true, ms: Date.now() - t });
    } catch (e) {
      error = plainError(e);
      failedStep = i;
      steps.push({ index: i, step, ok: false, error, ms: Date.now() - t });
      break;
    }
  }

  const screenshot = `${check.id}.png`;
  await page.screenshot({ path: path.join(dir, screenshot), fullPage: false }).catch(() => {});
  await ctx.close();

  return {
    checkId: check.id,
    name: check.name,
    passed: failedStep === undefined,
    failedStep,
    error,
    steps,
    screenshot,
    consoleErrors: [...new Set(consoleErrors)].slice(0, 20),
    failedRequests: [...new Set(failedRequests)].slice(0, 20),
    durationMs: Date.now() - started,
  };
}
