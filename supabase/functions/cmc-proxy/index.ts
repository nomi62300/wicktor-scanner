// CoinMarketCap proxy — the ONLY place the real CMC_API_KEY exists.
// Wicktor's client-side JS never sees it; it just calls this function.
//
// Deploy: supabase functions deploy cmc-proxy
// Secret (run locally, never paste the key into chat/commits):
//   supabase secrets set CMC_API_KEY=your-key-here

const CMC_BASE = "https://pro-api.coinmarketcap.com";

// Whitelist of CMC endpoints this proxy will forward to. Keeps the open
// function from being used to hit arbitrary CMC endpoints (and burn the
// shared 15k/month credit budget) even if someone finds the URL.
const ALLOWED_PATHS = new Set([
  "/v1/global-metrics/quotes/latest", // fallback for CoinGecko's /global
  "/v1/cryptocurrency/listings/latest", // fallback for coingeckoMarketCaps()
]);

// Only Wicktor's real deployed origins get CORS access — doesn't stop a
// server-side curl from using a leaked URL, but stops casual browser-based
// abuse from an arbitrary third-party page.
const ALLOWED_ORIGINS = new Set([
  "https://nomi62300.github.io",
  "https://beta.wicktor.top",
  "http://localhost:8000", // adjust/remove once done testing locally
]);

function corsHeaders(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "content-type",
    "Vary": "Origin",
  };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers });
  }

  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  if (!path || !ALLOWED_PATHS.has(path)) {
    return new Response(JSON.stringify({ error: "invalid or missing path" }), {
      status: 400,
      headers: { ...headers, "content-type": "application/json" },
    });
  }

  const apiKey = Deno.env.get("CMC_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "server misconfigured: CMC_API_KEY not set" }), {
      status: 500,
      headers: { ...headers, "content-type": "application/json" },
    });
  }

  // Forward every query param except our own `path` selector (e.g. limit,
  // start, convert) straight through to CMC.
  const cmcUrl = new URL(CMC_BASE + path);
  url.searchParams.forEach((value, key) => {
    if (key !== "path") cmcUrl.searchParams.set(key, value);
  });

  try {
    const cmcRes = await fetch(cmcUrl.toString(), {
      headers: { "X-CMC_PRO_API_KEY": apiKey, "Accept": "application/json" },
    });
    const body = await cmcRes.text();
    return new Response(body, {
      status: cmcRes.status,
      headers: { ...headers, "content-type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "upstream fetch failed", detail: String(err) }), {
      status: 502,
      headers: { ...headers, "content-type": "application/json" },
    });
  }
});
