// Self-contained HTML report (images inlined) that a non-developer can open, read and forward.

import fs from "node:fs";
import path from "node:path";
import type { Run } from "./types.js";
import { store } from "./store.js";
import type { compareRuns } from "./compare.js";
import { describeStep, elementNames } from "./words.js";

type Comparison = ReturnType<typeof compareRuns>;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function img(dir: string, file?: string): string {
  if (!file) return "";
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) return "";
  return `<img src="data:image/png;base64,${fs.readFileSync(p).toString("base64")}" alt="${esc(file)}"/>`;
}

export function writeReport(siteId: string, run: Run, cmp?: Comparison): string {
  const headDir = store.runDir(siteId, run.id);
  const baseDir = cmp ? store.runDir(siteId, cmp.baselineRunId) : undefined;
  const base = cmp ? store.getRun(siteId, cmp.baselineRunId) : undefined;
  const verdict = cmp?.verdict ?? (run.summary.failed ? "BROKEN" : "SAFE");
  const color = { SAFE: "#16a34a", CHANGED: "#d97706", BROKEN: "#dc2626" }[verdict];
  const checks = new Map(store.getChecks(siteId).map((c) => [c.id, c]));
  let names = new Map<string, string>();
  try { names = elementNames(store.getSite(siteId)); } catch { /* friendly names are optional */ }
  const change = run.change
    ? [run.change.label, run.change.issue ? `issue #${run.change.issue}` : "", run.change.files?.join(", ")].filter(Boolean).join(" · ")
    : "";

  const rows = run.results
    .map((r) => {
      const check = checks.get(r.checkId);
      const regs = cmp?.regressions.filter((x) => x.checkId === r.checkId) ?? [];
      const b = base?.results.find((x) => x.checkId === r.checkId);
      const diff = regs.find((x) => x.diffImage)?.diffImage;
      return `<section class="card ${r.passed ? "ok" : "bad"}">
  <h3>${r.passed ? "✅" : "❌"} ${esc(r.name)} <small>${(r.durationMs / 1000).toFixed(1)}s</small></h3>
  ${check?.intent ? `<p class="said">You said: <q>${esc(check.intent)}</q></p>` : ""}
  ${check?.stakes ? `<p class="stakes">At stake: ${esc(check.stakes)}</p>` : ""}
  ${r.error ? `<p class="err">${esc(r.error)}</p>` : ""}
  ${regs.map((x) => `<p class="reg"><b>${x.kind.replace(/_/g, " ")}</b> · ${esc(x.detail)}</p>`).join("")}
  <div class="shots">
    ${b && baseDir ? `<figure><figcaption>Before (baseline)</figcaption>${img(baseDir, b.screenshot)}</figure>` : ""}
    <figure><figcaption>After (this run)</figcaption>${img(headDir, r.screenshot)}</figure>
    ${diff ? `<figure><figcaption>What changed</figcaption>${img(headDir, diff)}</figure>` : ""}
  </div>
  <details><summary>Steps</summary><ol>${r.steps
    .map((s) => `<li class="${s.ok ? "" : "fail"}">${esc(describeStep(s.step, names))}${s.error ? ` — ${esc(s.error)}` : ""}</li>`)
    .join("")}</ol></details>
</section>`;
    })
    .join("\n");

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tripwire report · ${esc(run.targetUrl)}</title>
<style>
body{font:15px/1.5 system-ui,-apple-system,sans-serif;margin:0;background:#0b0d12;color:#e6e8ee}
header{padding:28px 32px;border-bottom:1px solid #222}
.verdict{display:inline-block;padding:4px 12px;border-radius:999px;background:${color};color:#fff;font-weight:700;letter-spacing:.05em}
h1{margin:10px 0 4px;font-size:22px} main{padding:24px 32px;display:grid;gap:18px}
.card{background:#141821;border:1px solid #232a36;border-radius:12px;padding:16px 18px}
.card.bad{border-color:#7f1d1d} h3{margin:0 0 8px} small{color:#8a93a6;font-weight:400}
.err{color:#fca5a5}.reg{color:#fcd34d;margin:4px 0}
.said{margin:2px 0;color:#e6e8ee}.said q{font-style:italic}.stakes{margin:2px 0 8px;color:#f0abfc}
.shots{display:flex;gap:12px;overflow-x:auto;margin-top:10px} figure{margin:0;flex:0 0 360px}
figure img{width:100%;border-radius:8px;border:1px solid #2b3240} figcaption{font-size:12px;color:#8a93a6;margin-bottom:4px}
li.fail{color:#fca5a5} details{margin-top:8px;color:#aab2c3}
</style></head><body>
<header><span class="verdict">${verdict}</span>
<h1>${esc(cmp?.headline ?? `${run.summary.passed}/${run.summary.total} checks passed`)}</h1>
<div>${esc(run.targetUrl)} · ${esc(run.label)} · ${new Date(run.startedAt).toLocaleString()}</div>
${change ? `<div>Change checked: ${esc(change)}</div>` : ""}
${cmp?.fixed.length ? `<p>Fixed since baseline: ${cmp.fixed.map(esc).join(", ")}</p>` : ""}
</header><main>${rows}</main></body></html>`;

  const file = path.join(headDir, "report.html");
  fs.writeFileSync(file, html);
  return file;
}
