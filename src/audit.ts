// Append-only audit trail of every tool call (JSONL).
// Same idea as audit-mcp-server: who asked for what, when, and what happened.

import fs from "node:fs";
import path from "node:path";
import { HOME } from "./store.js";

export function audit(tool: string, input: unknown, outcome: "ok" | "error", detail?: string) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    const line = JSON.stringify({
      at: new Date().toISOString(),
      tool,
      input,
      outcome,
      detail: detail?.slice(0, 500),
    });
    fs.appendFileSync(path.join(HOME, "audit.jsonl"), line + "\n");
  } catch {
    /* auditing must never break a tool call */
  }
}

export function readAudit(limit = 50): unknown[] {
  try {
    const lines = fs.readFileSync(path.join(HOME, "audit.jsonl"), "utf8").trim().split("\n");
    return lines.slice(-limit).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
