// Shared types for Tripwire.

export type Step =
  | { action: "goto"; path: string }
  | { action: "click"; selector?: string; text?: string }
  | { action: "fill"; selector: string; value: string }
  | { action: "select"; selector: string; value: string }
  | { action: "press"; key: string; selector?: string }
  | { action: "wait"; ms: number }
  | { action: "expectVisible"; selector?: string; text?: string }
  | { action: "expectNotVisible"; selector?: string; text?: string }
  | { action: "expectText"; selector: string; contains: string }
  | { action: "expectUrlContains"; value: string }
  | { action: "expectCount"; selector: string; count: number };

export interface Check {
  id: string;
  name: string;
  /** The plain-English intent the user gave. Kept verbatim: it is the spec. */
  intent: string;
  steps: Step[];
  /** Business importance, used for ordering and alert severity. */
  priority: "critical" | "high" | "normal";
  createdAt: string;
  /** What it costs the owner if this breaks, in their words. Shown with every verdict. */
  stakes?: string;
  source?: { githubIssue?: number };
}

/** The code change a run is checking, so a break can be traced to its cause. */
export interface Change {
  label?: string;
  issue?: number;
  files?: string[];
}

export interface PageInfo {
  url: string;
  path: string;
  title: string;
  headings: string[];
  links: { text: string; href: string }[];
  buttons: { text: string; selector: string }[];
  inputs: { name: string; type: string; label: string; selector: string }[];
  forms: { selector: string; fields: string[]; submitText: string }[];
}

export interface Site {
  id: string;
  baseUrl: string;
  scannedAt: string;
  scanner: "firecrawl" | "playwright";
  pages: PageInfo[];
  /** GitHub repo ("owner/repo") the site's code and issues live in. */
  repo?: string;
}

export interface StepResult {
  index: number;
  step: Step;
  ok: boolean;
  error?: string;
  ms: number;
}

export interface CheckResult {
  checkId: string;
  name: string;
  passed: boolean;
  failedStep?: number;
  error?: string;
  steps: StepResult[];
  screenshot: string; // relative to run dir
  consoleErrors: string[];
  failedRequests: string[]; // "METHOD URL -> status"
  durationMs: number;
}

export interface Run {
  id: string;
  siteId: string;
  targetUrl: string;
  label: string;
  startedAt: string;
  finishedAt: string;
  results: CheckResult[];
  summary: { total: number; passed: number; failed: number };
  change?: Change;
}

export interface Regression {
  checkId: string;
  name: string;
  kind: "newly_failing" | "visual_change" | "new_console_errors" | "new_failed_requests" | "slower";
  detail: string;
  severity: "critical" | "high" | "normal";
  diffImage?: string;
  /** For broken promises: the owner's words and what is at stake. */
  intent?: string;
  stakes?: string;
}
