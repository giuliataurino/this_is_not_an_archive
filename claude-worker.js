// This Is Not an Archive — Claude proxy (Cloudflare Worker)
//
// Holds the Anthropic API key as an encrypted Worker secret, so the key never
// appears in index.html or anywhere on GitHub. The page sends an OpenAI-style
// chat request here; this Worker converts it to Anthropic's Messages API and
// returns the answer in the same OpenAI-style shape the page already reads.
//
// Settings (Cloudflare dashboard → Worker → Settings → Variables and Secrets):
//   ANTHROPIC_API_KEY  (Secret, required)   your key from the Claude Console
//   ALLOWED_ORIGINS    (Text, required)     e.g. https://yourname.github.io
//   ALLOWED_MODELS     (Text, optional)     comma-separated; the first is the fallback
// Optional per-visitor rate limit: add a Rate Limiting binding named LIMITER.

const DEFAULT_MODELS = "claude-sonnet-5-5,claude-haiku-5-5,claude-opus-5-5";
const MAX_TOKENS_CAP = 3000;
const MAX_BODY_BYTES = 200_000;

// "HTTPS://Name.github.io/repo/" -> "https://name.github.io"
function normOrigin(value) {
  let v = String(value || "").trim().replace(/^["']|["']$/g, "");
  if (!v || v === "null") return "";
  if (!/^https?:\/\//i.test(v)) v = "https://" + v;
  try { return new URL(v).origin.toLowerCase(); } catch { return ""; }
}

export default {
  async fetch(request, env) {
    const origin = normOrigin(request.headers.get("Origin") || "");
    // ALLOWED_ORIGINS is forgiving: "https://name.github.io", "name.github.io/my-repo/",
    // "https://name.github.io/" all mean the same origin. Comma-separate several.
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(normOrigin).filter(Boolean);
    const originOk = !!origin && allowed.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": originOk ? origin : "null",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    };
    const reply = (status, obj) =>
      new Response(JSON.stringify(obj, null, 2), { status, headers: { ...cors, "Content-Type": "application/json" } });

    // Opening the Worker address in a browser tab: show a status check instead of an error
    if (request.method === "GET") {
      return reply(200, {
        status: "The proxy is running.",
        key: env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY is set." : "ANTHROPIC_API_KEY is missing: add it as a Secret.",
        accepts_requests_from: allowed.length ? allowed : "nobody yet: add ALLOWED_ORIGINS (your GitHub Pages address).",
        note: "The art site calls this address with POST; opening it directly is only a check."
      });
    }

    if (request.method === "OPTIONS") return new Response(null, { status: originOk ? 204 : 403, headers: cors });
    if (!originOk) {
      return reply(403, { error: { message:
        `This origin is not allowed. The request came from "${origin || "no origin"}"; ` +
        `ALLOWED_ORIGINS is ${allowed.length ? `"${allowed.join(", ")}"` : "empty"}. ` +
        `Set ALLOWED_ORIGINS to the address shown first.` } });
    }
    if (request.method !== "POST") return reply(405, { error: { message: "Use POST." } });
    if (!env.ANTHROPIC_API_KEY) return reply(500, { error: { message: "The proxy has no ANTHROPIC_API_KEY secret." } });

    if (env.LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.LIMITER.limit({ key: ip });
      if (!success) return reply(429, { error: { message: "Too many requests. Wait a minute." } });
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return reply(413, { error: { message: "Request too large." } });
    let body;
    try { body = JSON.parse(raw); } catch { return reply(400, { error: { message: "Body must be JSON." } }); }

    const models = (env.ALLOWED_MODELS || DEFAULT_MODELS).split(",").map(s => s.trim()).filter(Boolean);
    const model = models.includes(body.model) ? body.model : models[0];

    // OpenAI-style messages → Anthropic Messages API
    const system = [];
    const messages = [];
    for (const m of Array.isArray(body.messages) ? body.messages : []) {
      if (m.role === "system") { system.push(typeof m.content === "string" ? m.content : ""); continue; }
      const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content || []);
      const content = parts.map(p => {
        if (p.type === "text") return { type: "text", text: String(p.text || "") };
        if (p.type === "image_url") {
          const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
          if (typeof url === "string" && /^https:\/\//.test(url)) return { type: "image", source: { type: "url", url } };
        }
        return null;
      }).filter(Boolean);
      if (content.length) messages.push({ role: m.role === "assistant" ? "assistant" : "user", content });
    }
    if (!messages.length) return reply(400, { error: { message: "No messages." } });

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        max_tokens: Math.min(Number(body.max_tokens) || 2500, MAX_TOKENS_CAP),
        temperature: Math.max(0, Math.min(1, Number(body.temperature ?? 0.9))),
        system: system.join("\n\n") || undefined,
        messages
      })
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      // pass the status through, never the key or request details
      return reply(upstream.status, { error: { message: data?.error?.message || `Claude answered with status ${upstream.status}.` } });
    }
    const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    return reply(200, { model, choices: [{ message: { role: "assistant", content: text } }] });
  }
};
