// Browser acquisition. Three modes, in order:
// 1. TRIPWIRE_BROWSER_WS  -> connect to a remote browser (hosted runner on Render, Browserless, etc.)
// 2. TRIPWIRE_CHROME_PATH -> launch a specific Chrome/Chromium binary
// 3. Installed Google Chrome, then Playwright's own Chromium (npx playwright install chromium)

import { chromium, type Browser } from "playwright-core";

export async function getBrowser(): Promise<Browser> {
  const ws = process.env.TRIPWIRE_BROWSER_WS;
  if (ws) {
    return ws.startsWith("http") ? chromium.connectOverCDP(ws) : chromium.connect(ws);
  }
  const headless = process.env.TRIPWIRE_HEADFUL !== "1";
  const executablePath = process.env.TRIPWIRE_CHROME_PATH;
  if (executablePath) return chromium.launch({ executablePath, headless });
  try {
    return await chromium.launch({ channel: "chrome", headless });
  } catch {
    try {
      return await chromium.launch({ headless });
    } catch (e) {
      throw new Error(
        "No browser found. Install Google Chrome, run `npx playwright install chromium`, " +
          "or set TRIPWIRE_CHROME_PATH / TRIPWIRE_BROWSER_WS. Original error: " +
          (e as Error).message,
      );
    }
  }
}
