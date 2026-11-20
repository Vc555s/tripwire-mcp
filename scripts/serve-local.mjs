// Local fallback for the demo when the network is down: serves the shop from the local repo.
//   node scripts/serve-local.mjs
// http://localhost:4321 = the main branch (known-good), http://localhost:4322 = the working copy (the buggy branch).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./demo-lib.mjs";

export function serveLocal(env = loadEnv()) {
  const start = (port, ref) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(env.DEMO_SHOP_DIR, "serve.mjs")], {
      env: { ...process.env, PORT: String(port), ...(ref ? { REF: ref } : {}) },
      stdio: ["ignore", "pipe", "inherit"],
    });
    p.once("error", reject);
    p.stdout.once("data", (d) => { process.stdout.write(d); resolve(p); });
  });
  return Promise.all([start(4321, "main"), start(4322)]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await serveLocal();
  console.log("Local fallback is up. Press Ctrl+C to stop.");
}
