// GitHub Issues: read an issue and its acceptance criteria, file a regression with evidence,
// and comment on the issue whose change caused it.
// The repo comes from the site (set when it is scanned), else GITHUB_REPO ("owner/repo").
// Env: GITHUB_TOKEN (falls back to the GitHub CLI login), GITHUB_API_URL (GitHub Enterprise, tests).

import { execFileSync } from "node:child_process";
import { store } from "./store.js";
import { describeStep, elementNames } from "./words.js";

const DEFAULT_API = "https://api.github.com";
const api = () => (process.env.GITHUB_API_URL ?? DEFAULT_API).replace(/\/$/, "");

let cliToken: string | undefined;
/** GITHUB_TOKEN, or the GitHub CLI's login when talking to github.com, so there is no token to paste. */
function token(): string | undefined {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (api() !== DEFAULT_API) return undefined;
  if (cliToken === undefined) {
    try {
      cliToken = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
    } catch {
      cliToken = "";
    }
  }
  return cliToken || undefined;
}

/** The repo to use: the one asked for, else the one saved with the site, else GITHUB_REPO. */
function repoFor(explicit?: string, siteId?: string): string {
  let saved: string | undefined;
  if (!explicit && siteId) {
    try { saved = store.getSite(siteId).repo; } catch { /* unknown site: fall through to the default */ }
  }
  const r = explicit ?? saved ?? process.env.GITHUB_REPO;
  if (!r) throw new Error('Tripwire does not know which GitHub repo to use. Pass repo as "owner/repo", save it with tripwire_scan_site, or set GITHUB_REPO.');
  if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new Error(`"${r}" is not a repo name. Use "owner/repo".`);
  return r;
}

async function gh<T>(repo: string, method: string, pathname: string, body?: unknown): Promise<T> {
  const t = token();
  if (method !== "GET" && !t) throw new Error("Set GITHUB_TOKEN, or sign in with the GitHub CLI (`gh auth login`), to file issues.");
  const res = await fetch(`${api()}/repos/${repo}${pathname}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "tripwire-mcp",
      ...(t ? { Authorization: `Bearer ${t}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${pathname} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/** Pulls the acceptance criteria out of an issue body: the list under an "Acceptance criteria" heading, else every checklist item. */
export function acceptanceCriteria(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const item = (l: string) => l.match(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/)?.[1];
  const start = lines.findIndex((l) => /^\s*(#{1,6}\s*|\*\*)?acceptance criteria/i.test(l));
  if (start >= 0) {
    const out: string[] = [];
    for (const l of lines.slice(start + 1)) {
      if (/^\s*#{1,6}\s/.test(l)) break;
      const t = item(l);
      if (t) out.push(t);
    }
    if (out.length) return out;
  }
  return lines.map((l) => l.match(/^\s*[-*+]\s+\[[ xX]\]\s+(.+?)\s*$/)?.[1]).filter((t): t is string => !!t);
}

/** Reads an issue so the agent can turn its acceptance criteria into checks. */
export async function readIssue(number: number, siteId?: string, repoName?: string) {
  const repo = repoFor(repoName, siteId);
  const j = await gh<{ number: number; title: string; state: string; html_url: string; body: string | null; labels: { name: string }[] }>(
    repo, "GET", `/issues/${number}`,
  );
  const body = j.body ?? "";
  return {
    repo,
    issue: j.number,
    title: j.title,
    state: j.state,
    url: j.html_url,
    labels: (j.labels ?? []).map((l) => l.name),
    acceptanceCriteria: acceptanceCriteria(body),
    body,
  };
}

/** Files a failing check as an issue. If the run recorded the change that caused it (or linkTo is given), comments on that issue too. */
export async function fileIssue(siteId: string, runId?: string, checkId?: string, linkTo?: number, repoName?: string) {
  const repo = repoFor(repoName, siteId);
  const run = runId ? store.getRun(siteId, runId) : store.listRuns(siteId).at(-1);
  if (!run) throw new Error("No runs yet. Call tripwire_guard first.");
  const r = checkId ? run.results.find((x) => x.checkId === checkId) : run.results.find((x) => !x.passed);
  if (!r) throw new Error(checkId ? `Check ${checkId} is not in run ${run.id}.` : `Nothing failed in run ${run.id}, so there is nothing to file.`);
  const check = store.getChecks(siteId).find((c) => c.id === r.checkId);
  let names = new Map<string, string>();
  try { names = elementNames(store.getSite(siteId)); } catch { /* a report without friendly names is still a report */ }

  const cause = linkTo ?? run.change?.issue;
  const promise = check?.intent ?? r.name;
  const lines = [
    `**Promise:** ${promise}`,
    check?.stakes ? `**What is at stake:** ${check.stakes}` : "",
    `**Where:** ${run.targetUrl}`,
    r.passed ? "**Status:** passing" : `**What happened:** failed at step ${(r.failedStep ?? 0) + 1}. ${r.error}`,
    cause ? `**Caused by:** the change for #${cause}${run.change?.label ? ` (${run.change.label})` : ""}` : run.change?.label ? `**Change:** ${run.change.label}` : "",
    run.change?.files?.length ? `**Files changed:** ${run.change.files.map((f) => `\`${f}\``).join(", ")}` : "",
    r.consoleErrors.length ? `**Browser errors:** ${r.consoleErrors.slice(0, 5).join(" | ")}` : "",
    r.failedRequests.length ? `**Failing requests:** ${r.failedRequests.slice(0, 5).join(" | ")}` : "",
    "",
    "### Steps to reproduce",
    ...r.steps.map((s, i) => `${i + 1}. ${describeStep(s.step, names)}${s.ok ? "" : "  **<- fails here**"}`),
    ...(r.failedStep !== undefined && r.steps.length < (check?.steps.length ?? 0) ? [`\n_${check!.steps.length - r.steps.length} later step(s) did not run._`] : []),
    "",
    `_Found by Tripwire in run \`${run.id}\`. The screenshot and full report are in the Tripwire report for that run._`,
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "");

  const created = await gh<{ number: number; html_url: string }>(repo, "POST", "/issues", {
    title: `Regression: ${r.name}`,
    body: lines.join("\n"),
    labels: ["regression", "tripwire"],
  });

  let comment: string | undefined;
  if (cause) {
    try {
      const c = await gh<{ html_url: string }>(repo, "POST", `/issues/${cause}/comments`, {
        body: `Tripwire: the change for this issue broke a guarded promise.\n\n> ${promise}\n\n${r.error ?? ""}\n\nDetails and steps to reproduce: #${created.number}`,
      });
      comment = c.html_url;
    } catch (e) {
      comment = `could not comment on #${cause}: ${(e as Error).message}`;
    }
  }
  return { issue: created.number, url: created.html_url, repo, linkedTo: cause, comment };
}
