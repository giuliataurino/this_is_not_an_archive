# Connecting Claude securely

GitHub Pages only serves public files, so any key written into `index.html`
can be read by anyone. Instead, the key lives inside a small Cloudflare Worker
(free plan is enough). The page talks to the Worker; the Worker talks to Claude.
Nothing secret is ever committed to GitHub.

```
iPad / browser ──► index.html (GitHub Pages, public, no key)
                      │
                      ▼
               Cloudflare Worker  ── holds ANTHROPIC_API_KEY as a secret
                      │
                      ▼
               api.anthropic.com
```

## 1. Create an API key

1. Sign in at **console.anthropic.com** (the Claude Console — a Claude.ai
   subscription does not include API access; the Console is billed separately).
2. **Settings → Limits**: set a monthly spend limit.
3. **API Keys → Create Key**. Copy it once; you'll paste it into Cloudflare, nowhere else.

## 2. Create the Worker (dashboard, no command line)

1. Sign in at **dash.cloudflare.com** → **Workers & Pages** → **Create** → **Create Worker**.
   Name it e.g. `not-an-archive-claude` and deploy the placeholder.
2. **Edit code**: delete everything, paste the contents of `proxy/claude-worker.js`, **Deploy**.
3. **Settings → Variables and Secrets**:
   - Add **Secret** `ANTHROPIC_API_KEY` → paste the key. (Secrets are encrypted and can't be read back, even in the dashboard.)
   - Add **Text** `ALLOWED_ORIGINS` → `https://YOUR-GITHUB-USERNAME.github.io`
     (your Pages site; a trailing slash or `/repo-name` is ignored. For a custom
     domain, use that domain. Several addresses can be comma-separated.)
4. Copy the Worker's address, e.g. `https://not-an-archive-claude.yourname.workers.dev`.

Optional, recommended: under **Settings → Bindings** add a **Rate Limiting**
binding named `LIMITER` (e.g. 20 requests per 60 seconds) so one visitor
can't run up your bill.

## 3. Point the page at the Worker

In `index.html`, near the top of the script, set:

```js
const CLAUDE_PROXY_URL = "https://not-an-archive-claude.yourname.workers.dev";
```

Commit and push. Claude becomes the default model for every visitor; no one is
asked for a key. (The Worker's address is not a secret: it only answers your
GitHub Pages site, and only with the models you allow.)

## Command-line alternative

```bash
cd proxy
npm install -g wrangler
wrangler login
wrangler secret put ANTHROPIC_API_KEY     # paste the key when prompted
# edit ALLOWED_ORIGINS in wrangler.toml
wrangler deploy
```

## Checks

- Open the Worker address in a browser tab: it shows whether the key is set and
  which site it accepts. (It only answers the art site itself, by POST.)
- If the site shows "This origin is not allowed", the message names the address
  the request came from; put exactly that in `ALLOWED_ORIGINS`. Opening `index.html`
  from Files or your computer won't work: it has no web address. Test on the GitHub Pages site.

- Search a painting on the site, open it, tap **Negation Metadata**: it should read
  "Unsaying the record…" and then fill in. The record footer names the Claude model.
- `index.html` should contain no string starting with `sk-ant`. The repository's
  `.gitignore` also keeps local secret files (`.dev.vars`, `.env`) out of git.
- If a key is ever exposed, revoke it in the Console and add a new secret in Cloudflare.
