# Roadmap

Planned work, in priority order. Each item has an ID, a definition of done, and a
checkbox. Check the box in the same commit that satisfies it, and put the ID in the commit
message (`P0-1: add SSRF guard`).

Status legend: `[ ]` not started · `[x]` done · `[~]` blocked (say why inline)

Everything below came out of measuring this plugin against the alternatives in November
2026. The shipped version is deliberately minimal; none of this is implemented yet.

## Why this order — field notes

Measured from this machine (see [README](README.md#web_read) for the fetch comparison):

| Channel | Result |
|---|---|
| DeepSeek Search / Fetch | works, ~0.4 s, $0.75 / 1k, balance funded |
| Local `curl` | works, free, reaches sites the crawler refuses |
| DuckDuckGo HTML / lite scraping | dead: 202 challenge, 0 external links |
| Bing scraping | dead: consent shell, 0 external links |
| Firecrawl keyless tier | dead: 403, egress IP treated as VPN |
| ZAI `web_search_prime` MCP | reachable, quota exhausted until 2026-11-05 |
| OpenAI-compatible gateway | Codex-only, 403 for plain Responses calls |
| Exa hosted MCP (`mcp.exa.ai/mcp`) | works without a key: 4 results, ~6.6 s |

So: a keyless-DDG extension buys nothing here, and anything that reuses a subscription
needs that subscription in quota. DeepSeek + local curl is the only pair that is both
dependency-free and fast — which is why safety and diagnostics come before new backends.

## P0 — safety, cheap

### [x] P0-1 SSRF guard on `web_read`

`web_read` fetches whatever URL it is given, including `http://127.0.0.1:8080` and cloud
metadata addresses. Resolve the host and refuse loopback, link-local, private ranges and
non-HTTP schemes before either curl or the API call. Applies to redirect targets too, or
document why it cannot.

**Done when** `web_read` on `http://127.0.0.1/`, `http://169.254.169.254/` and
`http://10.0.0.1/` returns an error without a request leaving the process, and a unit test
covers it without touching the network.

Done: `guard.ts` classifies every address (IPv4, IPv6, v4-mapped, v4-translated,
v4-compatible, NAT64 incl. RFC 8215, 6to4) and refuses single-label and `.internal`-style
names; `curl -L` became a hand-rolled redirect loop so each hop is checked, and curl is
pinned with `--resolve` to the address that was checked. `guard.test.ts` (offline) plus two
tool tests in `tools.test.ts`: one proves a local HTTP server receives zero connections, one
proves a redirect into `127.0.0.1` is not followed.

Cross-review (CodeBuddy, second opinion) found three things the URL battery could not see,
all fixed: a `~/.curlrc` could add `-L`/`-x` and silently undo the hop guard (curl now runs
with `-q` first); a proxy makes `--resolve` inert (documented, reported by `/deepseek
doctor`, guarded URL checks unaffected); DNS answers of `0.0.0.0`/`::` used by blocklists no
longer reject a host that also has a usable address.

### [x] P0-2 Mark page text untrusted, strip obvious injections

Borrow the idea from `pi-safe-search`: wrap fetched content in an explicit untrusted-source
block, and drop paragraphs that read like instructions aimed at the agent ("ignore previous
instructions", "you are now…") plus hidden text (`display:none`). Heuristic only, no model
call.

**Done when** a fixture page with a classic injection paragraph comes back without that
paragraph, with a note saying one was removed, and the marker survives paging.

Done: `stripInjected` (16 patterns, sentence-level so padding cannot disarm it) plus
hidden-element removal in `htmlToMarkdown`; text is filtered once, before caching, and
`web_read` wraps every chunk in untrusted markers. Checked against six ordinary pages
(0 removals) and the Wikipedia/OWASP injection articles (2 and 5, which the note reports).

Cross-review found the framing itself was forgeable — a page could print the END marker and
continue outside the block, and the page title sat above it — so the markers now carry a
per-call nonce, marker-like lines are defanged, and the title moved inside the block.
`opacity:0`, `height:0`, off-screen positioning and `sr-only`-style classes are dropped too.

### [x] P0-3 `/deepseek doctor`

One command that probes: key source, balance, DeepSeek reachability, `curl` presence, and
whether the known-blocked hosts (Wikipedia, Stack Overflow, HN, `raw.githubusercontent.com`)
answer locally. This environment changes underneath the plugin; guessing costs more than
probing.

**Done when** `/deepseek doctor` prints one line per check with ok/fail and a one-line fix,
and the command never hangs longer than ~15 s total.

Done: eight checks (key, balance, api.deepseek.com, curl, four known-blocked hosts), each
capped at 7 s and all started together, ~1 s in practice. A live test asserts one aligned
`ok`/`fail` line per check and the 15 s ceiling.

## P1 — the free second opinion

### [ ] P1-1 Exa as an optional search backend

`web_search` gains `provider: "auto" | "deepseek" | "exa"`. The Exa path speaks JSON-RPC to
`https://mcp.exa.ai/mcp` (`web_search_exa`), works with no key, and uses `EXA_API_KEY` when
present (free tier: $10/month ≈ 2 500 lite searches, reset monthly).

Respect the differences instead of papering over them: Exa is semantic, so queries should
describe the wanted page rather than use operators; it returns excerpts, not 1–4 KB
summaries; it is ~6.6 s versus ~0.4 s.

**Done when** `provider: "exa"` returns the same output shape, `auto` falls back to Exa only
when DeepSeek fails or has no key, and the footer names the engine and whether it was free.

### [ ] P1-2 Exa as a `web_read` fallback

Both current engines fail on exactly the pages worth reading most: Stack Overflow, Reddit,
Zhihu, NYTimes, Medium, mvnrepository. `web_fetch_exa` on the hosted MCP is a third attempt
that has not been tried; `/contents` ($1 / 1k pages) is the paid version of the same idea.

**Done when** the Stack Overflow case returns content with `via: curl→deepseek→exa`, or the
item is closed with the reason it cannot.

## P2 — content the fetcher cannot see

### [ ] P2-1 PDF text extraction

`web_read` currently stops at "this is a PDF". Use `pdftotext` when installed, fall back to a
minimal embedded-text parser, and say which ran. Most specs and papers are PDFs.

**Done when** an arxiv PDF returns its first page of text with `via` naming the extractor,
and a scanned/solid-image PDF fails with a clear message instead of noise.

### [ ] P2-2 GitHub-aware reading

`github.com/.../blob/...` → fetch the raw file; repo root → the README; small shallow-clone
cache for multi-file reads. This is what `@vanillagreen/pi-web-tools` does well.

**Done when** a blob URL, a repo root and a raw URL all return the expected text, and the
repo-root case does not download the whole tree.

### [ ] P2-3 Provider-native search as a free lane

When the active provider ships a server-side search tool (ZAI `web_search_prime`, Anthropic
`web_search`, Gemini grounding) that search is already paid for. Wire it behind
`provider: "native"` with the same output shape.

**Done when** it works against a provider that is in quota, and fails with a clear
"quota exhausted / not available for this provider" message otherwise. Blocked in practice
until a quota resets; do not fake it.

## Adopted off-roadmap

### [x] A-1 GLM as a second search backend (adopted 2026-11-30, requested directly)

`web_search` gains `provider: "auto" | "deepseek" | "glm"` and `glm_engine`. The GLM path
speaks to `POST open.bigmodel.cn/api/paas/v4/web_search` (`glm.ts`), reuses the shared error
type, rate limiter and result shape, and works with a Pi Z.AI login, `GLM_API_KEY` or
`ZAI_API_KEY`. Differences are respected: 70-char query cap, whitelist-only domain filter
(`blocked_domains` is refused), no operators, no authority score, per-call pricing by engine
(0.01–0.05 元/次, footer shows the USD estimate).

**Done when** `provider: "glm"` returns the shared output shape against the real API,
`auto` falls back to GLM only when DeepSeek has no key or fails (and the body says so),
`provider: "deepseek"` never silently switches, and the footer names the engine and cost.

Done: live-verified `provider: "glm"`, the no-DeepSeek-key auto fallback, the failure
fallback with its note, and the deepseek-no-key error. Unit tests in `glm.test.ts` cover
request building, hit mapping, pricing, retry and failure classification.

## P3 — nice to have

### [ ] P3-1 Search hygiene by default

Ship a small default `blocked_domains` list (aggregator farms, `ecosyste.ms`, baijiahao)
instead of asking the model to notice them. Must be overridable per call and documented in
the tool description.

### [ ] P3-2 Structured output

`outputSchema` + `structuredContent` for both tools, so codemode scripts get result arrays
instead of Markdown. Text content stays for the model.

### [ ] P3-3 Store-and-preview for long pages

Alternative to offset paging: keep the full text in the session, return a preview plus a
content id, add a `page_get` lookup. Only worth it if paging turns out to be clumsy in
practice — measure before building.

### [ ] P3-4 Budget telemetry

Log query, result count, whether a read followed, and trimmed bytes, so the 24 000-character
default is tuned against real usage instead of guesswork. Local file only, no network.

### [ ] P3-5 YouTube transcripts

Caption fetch for talks and conference recordings, behind the same result shape as
`web_read`.
