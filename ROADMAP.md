# Roadmap / backlog

Everything below came out of measuring the current plugin against the alternatives in
November 2026. Nothing here is implemented yet — the shipped version is deliberately
minimal. Ordered by what actually hurts.

## Field notes that drive the order

Measured from this machine (see the README for the fetch comparison):

| Channel | Result |
|---|---|
| DeepSeek Search / Fetch | works, ~0.4 s, $0.75 / 1k, balance funded |
| Local `curl` | works, free, reaches sites the crawler refuses |
| DuckDuckGo HTML / lite scraping | dead: 202 challenge, 0 external links |
| Bing scraping | dead: consent shell, 0 external links |
| Firecrawl keyless tier | dead: 403, egress IP treated as VPN |
| ZAI `web_search_prime` MCP | reachable, quota exhausted until 2026-11-05 |
| OpenAI-compatible gateway | Codex-only, 403 for plain Responses calls |
| **Exa hosted MCP (`mcp.exa.ai/mcp`)** | **works without a key**: 4 results, ~6.6 s |

Consequence: a keyless-DDG based extension buys nothing here, and every provider that
reuses a subscription needs that subscription to be in quota. DeepSeek plus local curl is
the only combination that is both free of external dependencies and fast.

## P0 — safety, cheap

### 1. SSRF guard on `web_read`

`web_read` currently fetches whatever URL it is given, including `http://127.0.0.1:8080`
and cloud metadata addresses. Resolve the host and refuse loopback, link-local, private
ranges, and non-HTTP schemes before either curl or the API call.

*Done when:* `web_read` on `http://127.0.0.1/`, `http://169.254.169.254/`,
`http://10.0.0.1/` returns an error without a request leaving the process, and the check
is covered by a unit test that does not hit the network.

### 2. Mark page text as untrusted, strip obvious injections

Borrow the idea from `pi-safe-search`: wrap fetched content in an explicit
`<untrusted-source>` style block, and drop paragraphs that read like instructions aimed at
the agent ("ignore previous instructions", "you are now…", hidden text with
`display:none`). Cheap heuristic, no model call.

*Done when:* a fixture page containing a classic prompt-injection paragraph comes back
without that paragraph and with a note saying one was removed.

### 3. `/deepseek doctor`

Probe, in one command: key source, balance, DeepSeek reachability, whether `curl` exists,
and whether the known-blocked hosts (Wikipedia, Stack Overflow, HN,
`raw.githubusercontent.com`) are reachable locally. This environment changes underneath
the plugin often enough that guessing costs more than probing.

*Done when:* `/deepseek doctor` prints one line per check with ok/fail and a one-line fix.

## P1 — the free second opinion

### 4. Exa as an optional search backend

`web_search` gains `provider: "auto" | "deepseek" | "exa"`. The Exa path speaks JSON-RPC
to `https://mcp.exa.ai/mcp` (`web_search_exa`), which works with no key at all, and uses
`EXA_API_KEY` when present (free tier is $10/month ≈ 2 500 lite searches, reset monthly).

Differences to respect rather than paper over: Exa is semantic, so queries should describe
the page ("blog post comparing React and Vue performance") instead of using operators;
it returns excerpts, not 1–4 KB summaries; it is ~6.6 s versus ~0.4 s.

*Done when:* `provider: "exa"` returns results in the same output shape, `auto` falls back
to Exa only when DeepSeek fails or the key is absent, and the footer says which engine
answered and whether it was free.

### 5. Exa as a `web_read` fallback

Both engines fail on exactly the six pages worth reading most: Stack Overflow, Reddit,
Zhihu, NYTimes, Medium, mvnrepository. `web_fetch_exa` on the hosted MCP is a third
attempt that has not been tried yet, and `/contents` ($1 / 1k pages) is a paid version of
the same idea.

*Done when:* the Stack Overflow case in the README's failure list returns content with
`via: curl→deepseek→exa`, or the roadmap says why it could not.

## P2 — content types the fetcher cannot see

### 6. PDF text extraction

`web_read` currently stops at "this is a PDF". Use `pdftotext` when it is installed, fall
back to a minimal embedded-text parser, and say which one ran. Most specs and papers are
PDFs, so this is a large hole.

### 7. GitHub-aware reading

`github.com/.../blob/...` → fetch the raw file; repo root → the README; keep a shallow
clone cache for multi-file reads. This is what `@vanillagreen/pi-web-tools` does well.

### 8. Provider-native search as a free lane

When the active provider offers a server-side search tool (ZAI `web_search_prime`,
Anthropic `web_search`, Gemini grounding), that search is already paid for by the
subscription. Wire it behind `provider: "native"`, keeping the same output shape. Blocked
in practice by quotas, so it is not worth doing before P1.

## P3 — nice to have

- **Search-result hygiene by default**: ship a small default `blocked_domains` list
  (aggregator farms, `ecosyste.ms`, baijiahao) instead of asking the model to notice them.
- **Structured output** (`outputSchema` + `structuredContent`) so codemode scripts get
  result arrays instead of Markdown.
- **Store-and-preview** instead of offset paging for very long pages: keep the full text in
  the session, return a preview plus a content id, and add a `get_page` lookup.
- **Budget telemetry**: log query, result count, whether a read followed, so the 24 000
  character default can be tuned against real usage instead of guesswork.
- **YouTube transcripts** for talks and conference recordings.
