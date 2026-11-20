// Shared by the demo scripts: settings from demo.env and a client for the Tripwire server.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Settings from demo.env (copy demo.env.example), overridden by real environment variables. */
export function loadEnv(profile) {
  const name = profile ? `demo.${profile}.env` : "demo.env";
  const file = path.join(ROOT, name);
  if (!fs.existsSync(file)) throw new Error(`${name} not found. Copy demo.env.example to ${name} and fill it in.`);
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = process.env[m[1]] ?? m[2];
  }
  for (const k of ["MAIN_URL", "BRANCH_URL", "TRIPWIRE_HOME", "GITHUB_REPO"]) if (!env[k]) throw new Error(`demo.env is missing ${k}.`);
  env.SEED_HOME = `${env.TRIPWIRE_HOME}.seed`;
  return env;
}

/** Starts the built server with the given data folder and returns a `call(tool, args)` helper. */
export async function connect(env, home = env.TRIPWIRE_HOME) {
  const client = new Client({ name: "tripwire-demo-script", version: "0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "dist", "index.js")],
    stderr: "ignore",
    env: { ...process.env, TRIPWIRE_HOME: home, GITHUB_REPO: env.GITHUB_REPO, FIRECRAWL_API_KEY: env.FIRECRAWL_API_KEY ?? "" },
  }));
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content.find((c) => c.type === "text")?.text ?? "";
    if (r.isError) throw new Error(`${name}: ${text}`);
    let json = text;
    try { json = JSON.parse(text); } catch { /* plain text result */ }
    return { json, images: r.content.filter((c) => c.type === "image") };
  };
  return { client, call };
}

export function copyDir(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
}
