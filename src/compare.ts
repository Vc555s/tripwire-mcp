// Compares a run against the baseline and explains regressions in plain language.

import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import type { Regression, Run } from "./types.js";
import { store } from "./store.js";

const VISUAL_THRESHOLD = Number(process.env.TRIPWIRE_VISUAL_THRESHOLD ?? 0.02); // 2% of pixels

function visualDiff(baseFile: string, headFile: string, outFile: string): number | null {
  if (!fs.existsSync(baseFile) || !fs.existsSync(headFile)) return null;
  const a = PNG.sync.read(fs.readFileSync(baseFile));
  const b = PNG.sync.read(fs.readFileSync(headFile));
  if (a.width !== b.width || a.height !== b.height) return 1;
  const diff = new PNG({ width: a.width, height: a.height });
  const changed = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.15 });
  const ratio = changed / (a.width * a.height);
  if (ratio > 0) fs.writeFileSync(outFile, PNG.sync.write(diff));
  return ratio;
}

export function compareRuns(siteId: string, headRunId: string, baseRunId?: string) {
  const baselineId = baseRunId ?? store.getBaseline(siteId);
  if (!baselineId) throw new Error("No baseline yet. Run checks on a known-good version and call tripwire_set_baseline.");
  const base: Run = store.getRun(siteId, baselineId);
  const head: Run = store.getRun(siteId, headRunId);
  const checks = new Map(store.getChecks(siteId).map((c) => [c.id, c]));
  const baseDir = store.runDir(siteId, base.id);
  const headDir = store.runDir(siteId, head.id);

  const regressions: Regression[] = [];
  const fixed: string[] = [];

  for (const h of head.results) {
    const b = base.results.find((x) => x.checkId === h.checkId);
    const severity = checks.get(h.checkId)?.priority ?? "normal";
    if (!b) continue; // new check, nothing to compare against

    if (b.passed && !h.passed) {
      const step = h.failedStep !== undefined ? h.steps[h.failedStep]?.step : undefined;
      regressions.push({
        checkId: h.checkId,
        name: h.name,
        kind: "newly_failing",
        severity,
        detail: `Used to pass, now fails at step ${(h.failedStep ?? 0) + 1}${step ? ` (${step.action})` : ""}: ${h.error}`,
        intent: checks.get(h.checkId)?.intent,
        stakes: checks.get(h.checkId)?.stakes,
      });
    }
    if (!b.passed && h.passed) fixed.push(h.name);

    const newErrors = h.consoleErrors.filter((e) => !b.consoleErrors.includes(e));
    if (newErrors.length)
      regressions.push({
        checkId: h.checkId,
        name: h.name,
        kind: "new_console_errors",
        severity: "normal",
        detail: `New browser errors: ${newErrors.slice(0, 3).join(" | ")}`,
      });

    const newFailed = h.failedRequests.filter((e) => !b.failedRequests.includes(e));
    if (newFailed.length)
      regressions.push({
        checkId: h.checkId,
        name: h.name,
        kind: "new_failed_requests",
        severity: severity === "critical" ? "high" : "normal",
        detail: `New failing requests: ${newFailed.slice(0, 3).join(" | ")}`,
      });

    if (h.passed && b.passed && h.durationMs > b.durationMs * 2 && h.durationMs - b.durationMs > 2000)
      regressions.push({
        checkId: h.checkId,
        name: h.name,
        kind: "slower",
        severity: "normal",
        detail: `Took ${(h.durationMs / 1000).toFixed(1)}s, was ${(b.durationMs / 1000).toFixed(1)}s.`,
      });

    const diffName = `${h.checkId}.diff.png`;
    const ratio = visualDiff(path.join(baseDir, b.screenshot), path.join(headDir, h.screenshot), path.join(headDir, diffName));
    if (ratio !== null && ratio > VISUAL_THRESHOLD)
      regressions.push({
        checkId: h.checkId,
        name: h.name,
        kind: "visual_change",
        severity: "normal",
        detail: `${(ratio * 100).toFixed(1)}% of the screen looks different from the baseline.`,
        diffImage: diffName,
      });
  }

  const rank = { critical: 0, high: 1, normal: 2 } as const;
  regressions.sort((a, b) => rank[a.severity] - rank[b.severity]);
  const verdict = regressions.some((r) => r.kind === "newly_failing")
    ? "BROKEN"
    : regressions.length
      ? "CHANGED"
      : "SAFE";

  return {
    verdict,
    baselineRunId: base.id,
    headRunId: head.id,
    headline:
      verdict === "SAFE"
        ? `Nothing you guard broke. ${head.summary.passed}/${head.summary.total} checks pass, same as the baseline.`
        : verdict === "BROKEN"
          ? (() => {
              const broken = regressions.filter((r) => r.kind === "newly_failing");
              if (broken.length > 1) return `${broken.length} promises that used to hold are now broken.`;
              const b = broken[0]!;
              return `Broken promise: "${b.intent ?? b.name}".${b.stakes ? ` At stake: ${b.stakes}` : ""}`;
            })()
          : `No checks broke, but ${regressions.length} change${regressions.length === 1 ? " is" : "s are"} worth a look.`,
    change: head.change,
    regressions,
    fixed,
  };
}
