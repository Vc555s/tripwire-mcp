// Turns a scanned site into suggested checks a non-tester would care about.
// Heuristic on purpose: deterministic, free, instant. The agent in the editor refines the drafts.

import type { Check, Site, Step } from "./types.js";

export interface Suggestion {
  name: string;
  intent: string;
  priority: Check["priority"];
  page: string;
  draftSteps: Step[];
  why: string;
}

const has = (s: string, re: RegExp) => re.test(s.toLowerCase());

export function suggestChecks(site: Site): Suggestion[] {
  const out: Suggestion[] = [];
  const seenKinds = new Set<string>();
  const add = (kind: string, s: Suggestion) => {
    if (seenKinds.has(kind)) return;
    seenKinds.add(kind);
    out.push(s);
  };

  // Every important page should load and show its main heading.
  for (const p of site.pages.slice(0, 5)) {
    const h = p.headings[0];
    add(`load:${p.path}`, {
      name: `${p.path === "/" ? "Home page" : p.path} loads`,
      intent: `The ${p.path} page opens without errors${h ? ` and shows "${h}"` : ""}.`,
      priority: p.path === "/" ? "critical" : "normal",
      page: p.path,
      draftSteps: [{ action: "goto", path: p.path }, ...(h ? [{ action: "expectVisible", text: h } as Step] : [])],
      why: "Pages that stop loading are the most common silent breakage after a change.",
    });
  }

  for (const p of site.pages) {
    const inputs = p.inputs;
    const pw = inputs.find((i) => i.type === "password");
    const email = inputs.find((i) => i.type === "email" || has(i.name + i.label, /email|user/));
    const btnText = p.buttons.map((b) => b.text).join(" | ");
    const all = `${p.path} ${p.title} ${p.headings.join(" ")} ${btnText}`;

    if (pw && email) {
      const signup = has(all, /sign ?up|register|create account/);
      const submit = p.buttons.find((b) => has(b.text, /log ?in|sign ?in|sign ?up|register|continue|submit/));
      add(signup ? "signup" : "login", {
        name: signup ? "Sign-up works" : "Login works",
        intent: signup
          ? "A new visitor can create an account with an email and password."
          : "An existing user can log in with valid credentials and reaches their account.",
        priority: "critical",
        page: p.path,
        draftSteps: [
          { action: "goto", path: p.path },
          { action: "fill", selector: email.selector, value: "{{TEST_EMAIL}}" },
          { action: "fill", selector: pw.selector, value: "{{TEST_PASSWORD}}" },
          submit ? { action: "click", selector: submit.selector } : { action: "press", key: "Enter", selector: pw.selector },
          { action: "expectNotVisible", selector: pw.selector },
        ],
        why: "Auth flows break often and lock every user out at once.",
      });
    }

    const search = inputs.find((i) => i.type === "search" || has(i.name + i.label, /search|query|q$/));
    if (search) {
      add("search", {
        name: "Search returns results",
        intent: "Searching for a common term shows at least one result.",
        priority: "high",
        page: p.path,
        draftSteps: [
          { action: "goto", path: p.path },
          { action: "fill", selector: search.selector, value: "{{SEARCH_TERM}}" },
          { action: "press", key: "Enter", selector: search.selector },
          { action: "expectVisible", text: "{{EXPECTED_RESULT_TEXT}}" },
        ],
        why: "Search is a core path to revenue on most sites.",
      });
    }

    const addToCart = p.buttons.find((b) => has(b.text, /add to (cart|bag|basket)|buy now/));
    if (addToCart) {
      add("cart", {
        name: "Add to cart updates the cart",
        intent: "Adding a product to the cart increases the cart count and shows the correct total.",
        priority: "critical",
        page: p.path,
        draftSteps: [
          { action: "goto", path: p.path },
          { action: "click", selector: addToCart.selector },
          { action: "expectVisible", text: "{{CART_CONFIRMATION_TEXT}}" },
        ],
        why: "Checkout regressions cost money on every minute they go unnoticed.",
      });
    }
    if (has(all, /checkout|payment|place order/)) {
      add("checkout", {
        name: "Checkout page is reachable",
        intent: "A visitor with items in the cart can reach the checkout page and sees the order summary.",
        priority: "critical",
        page: p.path,
        draftSteps: [{ action: "goto", path: p.path }, { action: "expectVisible", text: "{{ORDER_SUMMARY_TEXT}}" }],
        why: "The last step before revenue.",
      });
    }

    const contact = p.forms.find((f) => f.fields.some((x) => has(x, /message|comment|enquiry|inquiry/)));
    if (contact) {
      add("contact", {
        name: "Contact form submits",
        intent: "Filling in the contact form and sending it shows a thank-you or confirmation message.",
        priority: "high",
        page: p.path,
        draftSteps: [
          { action: "goto", path: p.path },
          ...contact.fields.slice(0, 4).map(
            (f) => ({ action: "fill", selector: `${contact.selector} [name="${f}"]`, value: `{{${f.toUpperCase()}}}` }) as Step,
          ),
          { action: "click", selector: `${contact.selector} button, ${contact.selector} input[type=submit]` },
          { action: "expectVisible", text: "{{CONFIRMATION_TEXT}}" },
        ],
        why: "Lead forms fail silently: nobody complains about a message they couldn't send.",
      });
    }
  }

  // Navigation: the main nav links on the home page should all resolve.
  const home = site.pages.find((p) => p.path === "/" || p.path === "") ?? site.pages[0];
  if (home) {
    const nav = home.links.filter((l) => l.text && l.href.startsWith(site.baseUrl)).slice(0, 6);
    if (nav.length) {
      add("nav", {
        name: "Main navigation works",
        intent: `Each main menu link (${nav.map((n) => n.text).join(", ")}) opens its page.`,
        priority: "high",
        page: home.path,
        draftSteps: nav.flatMap((n) => [
          { action: "goto", path: home.path } as Step,
          { action: "click", text: n.text } as Step,
          { action: "expectUrlContains", value: new URL(n.href).pathname } as Step,
        ]),
        why: "Broken links are the most visible regression to real visitors.",
      });
    }
  }

  const rank = { critical: 0, high: 1, normal: 2 } as const;
  return out.sort((a, b) => rank[a.priority] - rank[b.priority]);
}
