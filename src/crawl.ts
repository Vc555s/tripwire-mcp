// Site scanning: discover pages, then extract what a user can interact with on each.
// Discovery starts from Firecrawl's /map when FIRECRAWL_API_KEY is set (handles sitemaps and JS sites)
// and always continues with a same-origin breadth-first crawl in Playwright. Extraction runs in a real browser
// so the selectors we hand back are ones Playwright can actually use.

import type { Page } from "playwright-core";
import { getBrowser } from "./browser.js";
import type { PageInfo, Site } from "./types.js";
import { siteIdFor } from "./store.js";

async function firecrawlMap(url: string, limit: number): Promise<string[] | null> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return null;
  const base = process.env.FIRECRAWL_API_URL ?? "https://api.firecrawl.dev";
  try {
    const res = await fetch(`${base}/v1/map`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, limit }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { links?: (string | { url: string })[] };
    const links = (body.links ?? []).map((l) => (typeof l === "string" ? l : l.url));
    const origin = new URL(url).origin;
    return [url, ...links.filter((l) => l.startsWith(origin))];
  } catch {
    return null;
  }
}

/** Runs inside the page. Must be self-contained (no closures over Node values). */
function extractInPage(): Omit<PageInfo, "url" | "path"> {
  const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const esc = (s: string) => (window as any).CSS?.escape ? (window as any).CSS.escape(s) : s.replace(/"/g, '\\"');
  const sel = (el: Element): string => {
    const tid = el.getAttribute("data-testid");
    if (tid) return `[data-testid="${tid}"]`;
    if (el.id) return `#${esc(el.id)}`;
    const name = el.getAttribute("name");
    if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
    const aria = el.getAttribute("aria-label");
    if (aria) return `${el.tagName.toLowerCase()}[aria-label="${aria}"]`;
    const t = text(el);
    if (t && (el.tagName === "BUTTON" || el.tagName === "A")) return `${el.tagName.toLowerCase()}:has-text("${t.slice(0, 40)}")`;
    const ph = el.getAttribute("placeholder");
    if (ph) return `${el.tagName.toLowerCase()}[placeholder="${ph}"]`;
    // Fallback: nth-of-type path (brittle, flagged by being long)
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.body && parts.length < 4) {
      const idx = Array.from(cur.parentElement?.children ?? []).filter((c) => c.tagName === cur!.tagName).indexOf(cur) + 1;
      parts.unshift(`${cur.tagName.toLowerCase()}:nth-of-type(${idx})`);
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  };
  const labelFor = (el: Element) => {
    const id = el.id;
    const lab = id ? document.querySelector(`label[for="${id}"]`) : el.closest("label");
    return (lab ? text(lab) : "") || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
  };
  const visible = (el: Element) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const inputs = Array.from(document.querySelectorAll("input, textarea, select"))
    .filter((el) => visible(el) && (el as HTMLInputElement).type !== "hidden")
    .slice(0, 40)
    .map((el) => ({
      name: el.getAttribute("name") ?? el.id ?? "",
      type: (el as HTMLInputElement).type ?? el.tagName.toLowerCase(),
      label: labelFor(el),
      selector: sel(el),
    }));
  const buttons = Array.from(document.querySelectorAll("button, [role=button], input[type=submit]"))
    .filter(visible)
    .slice(0, 40)
    .map((el) => ({ text: text(el) || (el as HTMLInputElement).value || "", selector: sel(el) }));
  const links = Array.from(document.querySelectorAll("a[href]"))
    .filter(visible)
    .slice(0, 60)
    .map((a) => ({ text: text(a), href: (a as HTMLAnchorElement).href }));
  const forms = Array.from(document.querySelectorAll("form"))
    .slice(0, 10)
    .map((f) => ({
      selector: sel(f),
      fields: Array.from(f.querySelectorAll("input, textarea, select"))
        .filter((el) => (el as HTMLInputElement).type !== "hidden")
        .map((el) => el.getAttribute("name") ?? el.id ?? el.getAttribute("type") ?? "field"),
      submitText: text(f.querySelector("button, input[type=submit]") ?? f) || "submit",
    }));
  const headings = Array.from(document.querySelectorAll("h1, h2")).slice(0, 10).map(text);
  return { title: document.title, headings, links, buttons, inputs, forms };
}

async function extract(page: Page, url: string): Promise<PageInfo> {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 }).catch(() => page.goto(url, { timeout: 30_000 }));
  const info = await page.evaluate(extractInPage);
  const u = new URL(page.url());
  return { url: page.url(), path: u.pathname + u.search, ...info };
}

export async function scanSite(baseUrl: string, maxPages = 15): Promise<Site> {
  const origin = new URL(baseUrl).origin;
  const mapped = await firecrawlMap(baseUrl, maxPages * 3);
  const browser = await getBrowser();
  const page = await browser.newPage();
  const pages: PageInfo[] = [];
  const seen = new Set<string>();
  const norm = (u: string) => {
    const x = new URL(u);
    x.hash = "";
    return x.toString().replace(/\/$/, "");
  };
  const queue: string[] = mapped ? [...new Set(mapped.map(norm))] : [norm(baseUrl)];

  try {
    while (queue.length && pages.length < maxPages) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);
      try {
        const info = await extract(page, next);
        pages.push(info);
        // Also follow the links on each page: Firecrawl's map can miss pages of a small or new site.
        for (const l of info.links) {
          if (!l.href.startsWith(origin)) continue;
          if (/\.(pdf|png|jpe?g|gif|svg|zip|mp4)$/i.test(l.href)) continue;
          if (/logout|signout|delete/i.test(l.href)) continue; // never click destructive links while scanning
          const n = norm(l.href);
          if (!seen.has(n)) queue.push(n);
        }
      } catch {
        /* skip unreachable page */
      }
    }
  } finally {
    await browser.close();
  }

  return {
    id: siteIdFor(baseUrl),
    baseUrl: origin,
    scannedAt: new Date().toISOString(),
    scanner: mapped ? "firecrawl" : "playwright",
    pages,
  };
}
