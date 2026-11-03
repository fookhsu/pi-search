# Working on this repo

`pi-deepseek-search` — two Pi tools (`web_search`, `web_read`) for reading the live web.
Zero runtime dependencies; the extension is loaded by Pi from `index.ts`.

## Start here

1. Read [ROADMAP.md](ROADMAP.md). Work on the highest-priority unchecked item.
2. Read the item's **Done when** before writing code. If what you built does not satisfy it,
   the item is not done.
3. Do not start a P1+ item while a P0 item is open unless the user says otherwise.
4. Tick the checkbox in the same commit that satisfies it, and put the item ID in the commit
   message: `P0-1: add SSRF guard on web_read`.

Features that are not on the roadmap: ask first. This plugin is deliberately small, and the
fastest way to ruin it is to bolt on a second abstraction layer nobody asked for.

## Layout

| File | Holds |
|---|---|
| `index.ts` | Tool definitions, rendering, the curl-first read strategy, `/deepseek` command |
| `api.ts` | DeepSeek transport: validation, retry, rate limiting, error classification |
| `extract.ts` | HTML→Markdown conversion, URL cleanup, paging, PDF detection |
| `cache.ts` | TTL+LRU cache used by both tools |
| `*.test.ts` | Unit tests; `tools.test.ts` runs the real tools against the real APIs |

## Invariants worth keeping

- **Never invent page content.** If both engines fail, say so and tell the caller what to run
  instead (`curl -sSL …`). An empty result is fine; a plausible-looking fake is not.
- **Context is the budget.** Every new field added to model-facing text has to earn its
  characters. Prefer a number in `details` over a sentence in `content`.
- **Cost and provenance go in the footer**, not in the body: `free` / `cached` / `$0.00075`,
  and which engine answered.
- **Zero runtime dependencies.** Node builtins only. The `typebox` import is a Pi peer.
- Tool names stay `web_search` and `web_read`; parameter names stay snake_case and stable.
- `web_read` order is curl → DeepSeek → (future) Exa, and the longer extraction wins. Do not
  reorder this without measuring; the field notes in the roadmap explain why.

## Testing

```bash
npm test          # unit tests, no network, must stay fast (<5 s)
npm run test:live  # real API calls, needs DEEPSEEK_API_KEY
pi -e ./index.ts   # load the extension without installing it
```

- New behaviour gets a unit test. Anything that talks to a host or parses real HTML also
  gets a live test, and live tests must `skip` when the key is missing.
- `node_modules` is a symlink to Pi's own dependency tree (git-ignored) so `typebox` and
  `@earendil-works/pi-tui` resolve outside the Pi process. Do not commit it.

## Style

- Comments explain *why*, not *what*. A comment that restates the next line is noise.
- Failure messages are the API: they name the next action.
- Prefer one obvious path over a configuration matrix. New options need a caller who asked
  for them.
