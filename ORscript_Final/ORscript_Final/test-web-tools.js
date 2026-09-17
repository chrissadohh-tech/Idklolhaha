// test-web-tools.js — web_fetch / web_search plumbing.
//
// These two tools ride the service worker's network stack, so they are gated by
// the extension's OWN CSP (content_security_policy.extension_pages) on top of
// manifest host permissions. Historically connect-src listed only localhost and
// ollama under `default-src 'none'`, so every external fetch was refused with
// "Failed to fetch" and both tools were dead. The first checks below lock the
// policy that keeps them alive; the rest unit-test the search parsers and the
// engine fallback chain by loading background.js in a plain Node vm.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let fails = 0, passes = 0;
const ok = (name, cond) => {
  if (cond) { passes++; console.log("PASS ", name); }
  else { fails++; console.log("FAIL ", name); }
};

const root = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const csp = (manifest.content_security_policy || {}).extension_pages || "";

// ── CSP / permissions ───────────────────────────────────────────────────────
ok("CSP connect-src allows https hosts (external fetch was refused before)",
  /connect-src[^;]*https:/.test(csp));
ok("CSP connect-src still allows the local bridge + ollama",
  /connect-src[^;]*ws:\/\/127\.0\.0\.1/.test(csp) && /connect-src[^;]*http:\/\/127\.0\.0\.1/.test(csp) &&
  /connect-src[^;]*ollama\.com/.test(csp));
ok("CSP keeps scripts locked to the extension itself",
  /script-src 'self'/.test(csp) && /default-src 'none'/.test(csp));
ok("host_permissions cover every https host (web_fetch targets)",
  (manifest.host_permissions || []).includes("https://*/*"));
ok("host_permissions keep localhost + roblox API hosts",
  (manifest.host_permissions || []).includes("http://127.0.0.1/*") &&
  (manifest.host_permissions || []).includes("https://*.roblox.com/*"));

// ── Load background.js in a sandbox (chainable chrome stub, no network) ─────
const chain = new Proxy(function () {}, {
  get(t, k) { return typeof k === "symbol" ? (k === Symbol.toPrimitive ? () => "" : chain) : chain; },
  set() { return true; },
  apply() { return chain; },
  construct() { return chain; },
});
const ctx = {
  chrome: chain, self: chain, window: chain, document: chain, navigator: chain,
  WebSocket: chain, module: { exports: {} }, console,
  fetch: async () => { throw new Error("no network in tests"); },
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
  URL, URLSearchParams, TextDecoder, Uint8Array, Promise, Set, Map,
  encodeURIComponent, decodeURIComponent, escape, unescape,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
const bgSrc = fs.readFileSync(path.join(root, "background.js"), "utf8");
vm.runInContext(bgSrc, ctx, { filename: "background.js" });
const api = ctx.module.exports || {};

ok("background.js exposes its web helpers to the test harness",
  !!(api.parseDdgHtml && api.parseDdgLite && api.parseHeadingAnchors && api.webSearch && api.htmlToText));

// ── request headers: no bot-flagged User-Agent ──────────────────────────────
const h = api.webHeaders ? api.webHeaders() : {};
ok("web headers do NOT fake a custom User-Agent (bot walls block those)",
  !("User-Agent" in h) && !("user-agent" in h));
ok("web headers send Accept + Accept-Language like a browser",
  /text\/html/.test(h.Accept || "") && /en-US/.test(h["Accept-Language"] || ""));

// ── DuckDuckGo html parser (redirect unwrapping + bold tags in the title) ───
const ddgHtml = '<html><body><div class="result results_links">' +
  '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fcreate.roblox.com%2Fdocs&amp;rut=abc">' +
  'Roblox <b>Docs</b> &amp; API</a>' +
  '<a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fcreate.roblox.com%2Fdocs">create.roblox.com</a>' +
  '</div></body></html>';
const ddgHits = api.parseDdgHtml(ddgHtml, 5);
ok("ddg-html parser unwraps the uddg redirect",
  ddgHits.length === 1 && ddgHits[0].url === "https://create.roblox.com/docs");
ok("ddg-html parser strips <b> tags + decodes entities in the title",
  ddgHits[0] && ddgHits[0].title === "Roblox Docs & API");

// ── DuckDuckGo lite parser ─────────────────────────────────────────────────
const liteHtml = '<table><tr><td><a rel="nofollow" href="https://example.org/page?a=1&amp;b=2" ' +
  'class="result-link">Example &amp; Co</a></td></tr></table>';
const liteHits = api.parseDdgLite(liteHtml, 5);
ok("ddg-lite parser finds .result-link anchors",
  liteHits.length === 1 && liteHits[0].url === "https://example.org/page?a=1&b=2" && liteHits[0].title === "Example & Co");

// ── Bing / Mojeek parser (base64url redirect unwrapping) ───────────────────
const targetUrl = "https://create.roblox.com/docs/reference/engine";
const wrapped = "https://www.bing.com/ck/a?!&&p=deadbeef&u=a1" + Buffer.from(targetUrl, "utf8").toString("base64url");
const bingHtml = '<ol id="b_results">' +
  '<li class="b_algo"><h2><a href="' + wrapped.replace(/&/g, "&amp;") + '">Roblox <strong>Engine</strong> Reference</a></h2>' +
  '<div class="b_caption"><p>snippet</p></div></li>' +
  '<li class="b_algo"><h2><a href="https://www.bing.com/search?q=internal">Internal Bing page</a></h2></li>' +
  '</ol>';
const bingHits = api.parseHeadingAnchors(bingHtml, 5);
ok("bing parser unwraps the base64url ck/a redirect",
  bingHits.length === 1 && bingHits[0].url === targetUrl);
ok("bing parser keeps the title and drops engine-internal links",
  bingHits[0] && bingHits[0].title === "Roblox Engine Reference");

const mojeekHtml = '<ul class="results-standard"><li><h2>' +
  '<a class="title" href="https://luau.org/syntax">Luau syntax</a></h2>' +
  '<p class="s">snippet</p></li></ul>';
const mojeekHits = api.parseHeadingAnchors(mojeekHtml, 5);
ok("mojeek parser reads <li><h2><a> results",
  mojeekHits.length === 1 && mojeekHits[0].url === "https://luau.org/syntax");

// ── engine fallback chain ──────────────────────────────────────────────────
(async () => {
  const calls = [];
  ctx.fetch = async (url) => {
    calls.push(url);
    if (/duckduckgo\.com/.test(url)) return { ok: false, status: 403, headers: { get: () => null }, text: async () => "" };
    if (/bing\.com\/search/.test(url)) return { ok: true, status: 200, headers: { get: () => null }, text: async () => bingHtml };
    return { ok: false, status: 500, headers: { get: () => null }, text: async () => "" };
  };
  const r = await api.webSearch("roblox engine reference", 3);
  ok("search falls through a blocked DDG to the next engine", r.engine === "bing" && r.results.length === 1);
  ok("search only tried engines until one answered", calls.length === 3);
  ok("search reports each failed engine instead of a bare failure",
    r.errors.length === 2 && /^ddg-html: HTTP 403/.test(r.errors[0]) && /^ddg-lite: HTTP 403/.test(r.errors[1]));

  // total miss: every engine down -> errors for each, no results
  ctx.fetch = async () => ({ ok: false, status: 503, headers: { get: () => null }, text: async () => "" });
  const miss = await api.webSearch("nothing", 3);
  ok("total search miss lists all four engines",
    miss.results.length === 0 && miss.errors.length === api.SEARCH_ENGINES.length);

  // duplicate urls from one engine are collapsed
  ctx.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => bingHtml + bingHtml });
  const dup = await api.webSearch("roblox", 3);
  ok("duplicate results are collapsed", dup.results.length === 1);

  // htmlToText sanity (used by web_fetch on HTML pages)
  const text = api.htmlToText("<html><head><style>b{}</style></head><body><h1>Hi</h1><script>x()</script><p>A &amp; B</p></body></html>");
  ok("htmlToText strips script/style and decodes entities",
    text.includes("Hi") && text.includes("A & B") && !text.includes("x()") && !text.includes("b{}"));

  // source-level: the fetch call must follow redirects and stay credential-free
  ok("web_fetch follows redirects without sending cookies",
    bgSrc.includes('redirect: "follow"') && bgSrc.includes('credentials: "omit"'));
  ok("web_fetch keeps the html->text path + truncation notice",
    bgSrc.includes("htmlToText(text)") && bgSrc.includes("[truncated "));
  ok("http:// targets are upgraded or explained, never a silent failure",
    bgSrc.includes("only reach https:// hosts") && bgSrc.includes('replace(/^http:\\/\\//i, "https://")'));

  if (fails) { console.log(`\n${fails} web-tool check(s) failed.`); process.exit(1); }
  console.log(`\nWeb-tool checks passed (${passes}).`);
})();
