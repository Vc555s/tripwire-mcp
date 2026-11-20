// Prepares the demo: scans the good build, saves the owner's promises, sets the baseline,
// and keeps a copy in <TRIPWIRE_HOME>.seed so reset-demo.mjs can restore it.
//   node scripts/seed-demo.mjs
import fs from "node:fs";
import { connect, copyDir, loadEnv } from "./demo-lib.mjs";

const env = loadEnv();
fs.rmSync(env.TRIPWIRE_HOME, { recursive: true, force: true });
const { client, call } = await connect(env);

try {
  const scan = (await call("tripwire_scan_site", { url: env.MAIN_URL, maxPages: 10 })).json;
  console.log(`scanned ${env.MAIN_URL} with ${scan.scanner}: ${scan.pages.map((p) => p.path).join(" ")}`);
  const siteId = scan.siteId;
  const suggestions = (await call("tripwire_suggest_checks", { siteId })).json.suggestions;
  console.log(`suggestions: ${suggestions.map((s) => s.name).join("; ")}`);

  const nav = suggestions.find((s) => s.name.startsWith("Main navigation"));
  const promises = [
    {
      name: "Discount code WELCOME10 takes 10% off", priority: "critical",
      intent: "If I add the Yirgacheffe and use WELCOME10, the total should be €13.05",
      stakes: "New customers pay full price and stop trusting the shop.",
      steps: [
        { action: "goto", path: "/shop" }, { action: "click", selector: "[data-testid=add-0]" },
        { action: "expectVisible", text: "Added to cart" }, { action: "goto", path: "/cart" },
        { action: "fill", selector: "#code", value: "WELCOME10" }, { action: "click", selector: "[data-testid=apply]" },
        { action: "expectText", selector: "[data-testid=total]", contains: "€13.05" },
      ],
    },
    {
      name: "Add to cart updates the cart", priority: "critical",
      intent: "When I add a coffee to the cart, it says Added to cart and the cart count goes up",
      stakes: "Nobody can buy anything.",
      steps: [
        { action: "goto", path: "/shop" }, { action: "click", selector: "[data-testid=add-0]" },
        { action: "expectVisible", text: "Added to cart" },
        { action: "expectText", selector: "[data-testid=cart-count]", contains: "1" },
      ],
    },
    {
      name: "Contact form sends", priority: "high",
      intent: "When someone fills in the contact form and sends it, they see a thank-you message",
      stakes: "I lose enquiries without knowing.",
      steps: [
        { action: "goto", path: "/contact" },
        { action: "fill", selector: "#name", value: "Ana" },
        { action: "fill", selector: "#email", value: "ana@example.com" },
        { action: "fill", selector: "#message", value: "Do you ship to Frankfurt?" },
        { action: "click", text: "Send message" },
        { action: "expectVisible", text: "Thanks" },
      ],
    },
    {
      name: "Main navigation works", priority: "high",
      intent: "Every link in the menu opens its page",
      stakes: "Visitors cannot find the shop.",
      steps: nav.draftSteps,
    },
  ];
  for (const p of promises) await call("tripwire_add_check", { siteId, ...p });

  const guard = (await call("tripwire_guard", { siteId, label: "known-good main" })).json;
  console.log(`${guard.verdict}: ${guard.headline}`);
  if (guard.verdict !== "BASELINE_SET") throw new Error(`Expected BASELINE_SET, got ${guard.verdict}: ${JSON.stringify(guard.failures ?? guard)}`);

  await client.close();
  copyDir(env.TRIPWIRE_HOME, env.SEED_HOME);
  console.log(`site id: ${siteId}\nstore:   ${env.TRIPWIRE_HOME}\nseed:    ${env.SEED_HOME}`);
} catch (e) {
  await client.close().catch(() => {});
  console.error(`seed failed: ${e.message}`);
  process.exit(1);
}
