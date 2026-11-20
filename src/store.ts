// File-based storage under ./.tripwire (or $TRIPWIRE_HOME).
// Plain JSON on disk keeps it inspectable, git-friendly and dependency-free.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Check, Run, Site } from "./types.js";

export const HOME = path.resolve(process.env.TRIPWIRE_HOME ?? path.join(process.cwd(), ".tripwire"));

function ensure(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
function writeJson(file: string, data: unknown) {
  ensure(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(4).toString("hex")}`;

export function siteIdFor(url: string): string {
  const u = new URL(url);
  return (u.host + u.pathname).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

const siteDir = (siteId: string) => path.join(HOME, "sites", siteId);

export const store = {
  saveSite(site: Site) {
    writeJson(path.join(siteDir(site.id), "site.json"), site);
  },
  getSite(siteId: string): Site {
    const s = readJson<Site | null>(path.join(siteDir(siteId), "site.json"), null);
    if (!s) throw new Error(`Unknown site "${siteId}". Run tripwire_scan_site first.`);
    return s;
  },
  listSites(): string[] {
    const d = path.join(HOME, "sites");
    return fs.existsSync(d) ? fs.readdirSync(d) : [];
  },

  getChecks(siteId: string): Check[] {
    return readJson<Check[]>(path.join(siteDir(siteId), "checks.json"), []);
  },
  saveChecks(siteId: string, checks: Check[]) {
    writeJson(path.join(siteDir(siteId), "checks.json"), checks);
  },

  runDir(siteId: string, runId: string) {
    return ensure(path.join(siteDir(siteId), "runs", runId));
  },
  saveRun(run: Run) {
    writeJson(path.join(this.runDir(run.siteId, run.id), "run.json"), run);
  },
  getRun(siteId: string, runId: string): Run {
    const r = readJson<Run | null>(path.join(siteDir(siteId), "runs", runId, "run.json"), null);
    if (!r) throw new Error(`Unknown run "${runId}" for site "${siteId}".`);
    return r;
  },
  listRuns(siteId: string): Run[] {
    const d = path.join(siteDir(siteId), "runs");
    if (!fs.existsSync(d)) return [];
    return fs
      .readdirSync(d)
      .map((id) => readJson<Run | null>(path.join(d, id, "run.json"), null))
      .filter((r): r is Run => !!r)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  },

  getBaseline(siteId: string): string | null {
    return readJson<{ runId: string } | null>(path.join(siteDir(siteId), "baseline.json"), null)?.runId ?? null;
  },
  setBaseline(siteId: string, runId: string) {
    writeJson(path.join(siteDir(siteId), "baseline.json"), { runId, setAt: new Date().toISOString() });
  },
};
