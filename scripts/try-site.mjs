// Read-only look at any site: what Tripwire finds and what it would suggest guarding. Saves nothing permanent.
//   node scripts/try-site.mjs https://example.com
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const url = process.argv[2];
if (!url) { console.error("usage: node scripts/try-site.mjs <url>"); process.exit(1); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tw-try-"));
const client = new Client({ name: "try-site", version: "0" });
await client.connect(new StdioClientTransport({
  command: process.execPath, args: [path.join(root, "dist", "index.js")], stderr: "ignore",
  env: { ...process.env, TRIPWIRE_HOME: home },
}));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.find((c) => c.type === "text")?.text ?? "";
  if (r.isError) throw new Error(text);
  return JSON.parse(text);
};
try {
  const scan = await call("tripwire_scan_site", { url, maxPages: 12 });
  console.log(`${scan.pages.length} page(s) found by the ${scan.scanner} scanner:`);
  for (const p of scan.pages) console.log(`  ${p.path.padEnd(28)} ${p.title}  [${p.buttons.length} buttons, ${p.inputs.length} inputs, ${p.forms.length} forms, ${p.links.length} links]`);
  const { suggestions } = await call("tripwire_suggest_checks", { siteId: scan.siteId });
  console.log(`\n${suggestions.length} suggestion(s):`);
  for (const s of suggestions) console.log(`  ${s.priority.padEnd(8)} ${s.intent}`);
} finally {
  await client.close().catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
}
