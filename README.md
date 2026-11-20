# Tripwire

**Describe what must keep working. Tripwire checks it after every change.**

AI agents write your app, but they forget what you promised your customers. Tripwire is the memory of those promises: you say them once in plain words, and the agent has to prove it kept them before every commit. The answer is one word, **SAFE, CHANGED or BROKEN**, with a screenshot.

Tripwire is an MCP server for Cursor. It is a standard MCP server, so other editors that speak MCP should work too. There is no test code to write and no extra AI key: the agent already in your editor does the thinking. Tripwire is the hands (a real browser) and the memory (your promises, the known-good baseline, the history).

---

## Why

AI tools made shipping fast, but checking didn't speed up. Most vibe-coded apps, small-business sites and side projects have **zero tests**, so a "harmless" refactor breaks checkout and nobody notices until a customer emails.

If your app takes money or leads and an AI edits it, something has to check the money path after every edit. Otherwise your customers are the ones who find out.

| Who | Pain | What Tripwire gives them |
|---|---|---|
| Founders who vibe code | Every AI edit might break something unrelated | `Did I break anything?` after each change, inside the editor |
| Small businesses | Forms and checkout fail silently | Promises in plain words, checked in a real browser |
| Agencies | Dozens of client sites, no test budget | One set of promises per client, reports they can forward |
| Small teams | Nobody knows which change broke what | Regressions filed as GitHub issues, linked to the issue that caused them |

---

## How it works

```
 you (plain words) ──► editor agent ──► Tripwire MCP ──► real browser
                                            │
      scan ─► suggest ─► promises ─► run ─► compare with baseline ─► verdict + report ─► GitHub issue
                                            │
                               .tripwire/ (sites, promises, runs, screenshots, audit.jsonl)
```

1. **Scan**: map the site's pages, links, buttons, inputs and forms. Firecrawl finds the pages when `FIRECRAWL_API_KEY` is set; otherwise Tripwire crawls the site itself and never follows logout or delete links.
2. **Suggest**: rank what a non-tester cares about: pages load, login and sign-up, search, cart, checkout, contact form, navigation.
3. **Promise**: you say what must keep working and what it costs you if it breaks. The agent turns it into browser steps. Your words are stored as the spec, next to what is at stake.
4. **Run**: a real browser, with evidence: screenshot, console errors, failed requests and timing.
5. **Compare** against the known-good baseline: newly failing promises, new browser errors, new failed requests, slowdowns and visual changes.
6. **Verdict**: one sentence that names the broken promise and what is at stake, the screenshot, and an HTML report a non-developer can open and forward.
7. **Close the loop**: file a GitHub issue with the promise, the steps to reproduce in plain words and the error. Tripwire also comments on the issue whose change caused the break.

### What a broken promise looks like

```
BROKEN
Broken promise: "If I add the Yirgacheffe and use WELCOME10, the total should be €13.05".
At stake: New customers pay full price and stop trusting the shop.
Used to pass, now fails at step 7: expected €13.05 but it showed €14.49.
```

---

## Tools

| Tool | What it does |
|---|---|
| `tripwire_scan_site` | Crawl a URL and map what a visitor can interact with. Pass `repo` to say which GitHub repo the site belongs to |
| `tripwire_suggest_checks` | Ranked plain-English suggestions with draft steps |
| `tripwire_add_check` | Save or replace a promise: intent, stakes and steps (needs at least one `expect*` step) |
| `tripwire_list_checks` / `tripwire_remove_check` | See or change what is guarded |
| `tripwire_run` | Run the checks, optionally against another deployment (`targetUrl`, e.g. a deploy preview) |
| `tripwire_set_baseline` | Mark a passing run as known-good |
| `tripwire_compare` | Verdict, regressions and report against the baseline |
| **`tripwire_guard`** | **One call after any change: run, compare, verdict.** Sets the first baseline automatically. Pass `change` (label, issue, files) to record what is being checked |
| `tripwire_file_issue` | File the regression as a GitHub issue and comment on the issue that caused it |
| `tripwire_read_issue` | Read a GitHub issue and extract its acceptance criteria, to turn them into checks |
| `tripwire_history` | Recent runs and the audit trail |

**Prompts** (slash commands in most clients): `guard_my_app(url)` and `verify_issue(issue, siteId)`.

**Step actions:** `goto`, `click`, `fill`, `select`, `press`, `wait`, `expectVisible`, `expectNotVisible`, `expectText`, `expectUrlContains`, `expectCount`. Values support `{{PLACEHOLDERS}}` filled from `vars` or `TRIPWIRE_VAR_<NAME>` environment variables, so secrets never live in the check file.

---

## Install

You need Node 18 or newer and Google Chrome.

```bash
git clone https://github.com/Vc555s/tripwire-mcp
cd tripwire-mcp
npm install && npm run build
```

Add it to `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` for every project):

```json
{
  "mcpServers": {
    "tripwire": {
      "command": "node",
      "args": ["/absolute/path/to/tripwire-mcp/dist/index.js"]
    }
  }
}
```

Then tell the agent: *"Set up Tripwire for http://localhost:3000, the code is in you/your-repo"*, or run the `guard_my_app` prompt.

To make the agent check on its own, add a project rule:

```md
<!-- .cursor/rules/tripwire.mdc -->
After any change that affects the UI, call tripwire_guard before committing.
If the verdict is BROKEN, show the screenshot and offer to fix it and file an issue.
Never edit a check to make it pass.
```

### Environment

| Variable | Purpose |
|---|---|
| `TRIPWIRE_HOME` | Data folder (default `./.tripwire`) |
| `FIRECRAWL_API_KEY` | Faster, deeper page discovery (optional) |
| `GITHUB_REPO` | Default `owner/repo` for issues. Not needed when the repo is given at scan time, which also lets one install guard several projects |
| `GITHUB_TOKEN` | Token for filing issues. If unset, Tripwire uses your GitHub CLI login (`gh auth login`) |
| `GITHUB_API_URL` | GitHub Enterprise address (optional) |
| `TRIPWIRE_BROWSER_WS` | Use a remote browser instead of local Chrome |
| `TRIPWIRE_CHROME_PATH`, `TRIPWIRE_HEADFUL=1` | Local browser control |
| `TRIPWIRE_STEP_TIMEOUT_MS`, `TRIPWIRE_VISUAL_THRESHOLD` | Tuning (defaults 8000 ms, 0.02) |

---

## Try the demo

The repo ships a small coffee shop with a **planted** bug: a "tidy-up" of the price helper that silently turns 10% off into 0.1% off.

```bash
node demo/serve.mjs                       # good build on :4321
BROKEN=1 PORT=4322 node demo/serve.mjs    # the "refactor" that breaks the discount code
node scripts/e2e.mjs                      # the whole flow, scripted, against a mock GitHub
```

The same shop is hosted, with the bug on a branch, at [Vc555s/tripwire-demo-shop](https://github.com/Vc555s/tripwire-demo-shop). `scripts/seed-demo.mjs`, `scripts/preflight.mjs`, `scripts/rehearse.mjs` and `scripts/reset-demo.mjs` set up, verify, rehearse and reset a live demo against it (copy `demo.env.example` to `demo.env` first).

More detail, with diagrams: [docs/WORKFLOW.md](docs/WORKFLOW.md).

---

## Roadmap

- **Checks that repair themselves**: when the page changed and a step cannot find its element, rebuild the steps from the stored sentence instead of reporting a break.
- **Watch while the laptop is closed**: a hosted runner with scheduled checks and alerts.
- **Deploy-preview gate**: run on every preview deploy and comment the verdict on the pull request.
- **Phone view**: run every promise at phone size too.
- **Editor extension**: one-click install, the verdict in the status bar.
- **Behavioural diff mode**: replay API traffic against the base and changed builds.

## License

MIT
