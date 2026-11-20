// Turns steps into sentences a non-developer can read, for reports and issues.

import type { Site, Step } from "./types.js";

const key = (selector: string) => selector.replace(/["']/g, "").trim();

/** Maps selectors found by the scan to friendly names, e.g. `#code` -> the "Discount code" field. */
export function elementNames(site?: Site): Map<string, string> {
  const names = new Map<string, string>();
  for (const p of site?.pages ?? []) {
    for (const i of p.inputs) if (i.label && !names.has(key(i.selector))) names.set(key(i.selector), `the "${i.label}" field`);
    for (const b of p.buttons) if (b.text && !names.has(key(b.selector))) names.set(key(b.selector), `the "${b.text}" button`);
  }
  return names;
}

export function describeStep(step: Step, names: Map<string, string> = new Map()): string {
  const el = (s: { selector?: string; text?: string }) =>
    s.text ? `"${s.text}"` : s.selector ? (names.get(key(s.selector)) ?? s.selector) : "the element";
  switch (step.action) {
    case "goto": return `Open ${step.path}`;
    case "click": return `Click ${el(step)}`;
    case "fill": return `Type "${step.value}" into ${el(step)}`;
    case "select": return `Choose "${step.value}" in ${el(step)}`;
    case "press": return `Press ${step.key}${step.selector ? ` in ${el(step)}` : ""}`;
    case "wait": return `Wait ${step.ms} ms`;
    case "expectVisible": return `Check that ${el(step)} is visible`;
    case "expectNotVisible": return `Check that ${el(step)} is not visible`;
    case "expectText": return `Check that ${el(step)} shows "${step.contains}"`;
    case "expectUrlContains": return `Check that the address contains "${step.value}"`;
    case "expectCount": return `Check that there are exactly ${step.count} of ${el(step)}`;
  }
}
