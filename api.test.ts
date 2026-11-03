import assert from "node:assert/strict";
import test from "node:test";
import {
  DeepSeekError,
  RateLimiter,
  buildSearchRequest,
  errorHint,
  fetchPage,
  search,
  validateFetchUrl,
} from "./api.ts";

test("buildSearchRequest validates the query and appends domain filters", () => {
  assert.deepEqual(buildSearchRequest({ query: "  rust async  " }), { query: "rust async" });
  assert.deepEqual(buildSearchRequest({ query: "rust", count: 5 }), { query: "rust", count: 5 });
  assert.deepEqual(
    buildSearchRequest({ query: "rust", allowed_domains: ["docs.rs", "crates.io"] }),
    { query: "rust site:docs.rs OR site:crates.io" },
  );
  assert.deepEqual(buildSearchRequest({ query: "rust", blocked_domains: ["csdn.net"] }), {
    query: "rust -site:csdn.net",
  });
  assert.deepEqual(buildSearchRequest({ query: "rust", include_content: true }), {
    query: "rust",
    need_content: true,
  });
});

test("buildSearchRequest rejects bad input", () => {
  assert.throws(() => buildSearchRequest({ query: "   " }), DeepSeekError);
  assert.throws(() => buildSearchRequest({ query: "x".repeat(129) }), DeepSeekError);
  assert.throws(() => buildSearchRequest({ query: "x", count: 0 }), DeepSeekError);
  assert.throws(() => buildSearchRequest({ query: "x", count: 51 }), DeepSeekError);
  assert.throws(
    () => buildSearchRequest({ query: "x", allowed_domains: ["a.com"], blocked_domains: ["b.com"] }),
    /cannot be combined/,
  );
  assert.throws(
    () => buildSearchRequest({ query: "x", allowed_domains: ["https://a.com/path"] }),
    /plain domain names/,
  );
});

test("validateFetchUrl only accepts plain http(s) URLs", () => {
  validateFetchUrl("https://example.com/a?b=1");
  assert.throws(() => validateFetchUrl("ftp://example.com"), DeepSeekError);
  assert.throws(() => validateFetchUrl("file:///etc/passwd"), DeepSeekError);
  assert.throws(() => validateFetchUrl("https://user:pw@example.com"), DeepSeekError);
  assert.throws(() => validateFetchUrl("not a url"), DeepSeekError);
});

test("404 on fetch maps to an actionable hint naming curl", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ error: { message: "failed to fetch URL (request_id: abc-123)" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

  await assert.rejects(
    () => fetchPage("key", "https://en.wikipedia.org/wiki/Java", { fetchImpl: fakeFetch }),
    (error: unknown) => {
      assert.ok(error instanceof DeepSeekError);
      assert.equal(error.kind, "unavailable");
      assert.equal(error.requestId, "abc-123");
      const hint = errorHint(error, { path: "fetch", url: "https://en.wikipedia.org/wiki/Java" });
      assert.match(hint, /curl -sSL 'https:\/\/en\.wikipedia\.org\/wiki\/Java'/);
      return true;
    },
  );
});

test("retries transient 5xx and succeeds", async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls++;
    if (calls === 1)
      return new Response("boom", { status: 503, headers: { "retry-after": "0" } });
    return new Response(JSON.stringify({ results: [{ title: "t", url: "https://a.test", authority: 3 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const outcome = await search("key", { query: "q" }, { fetchImpl: fakeFetch });
  assert.equal(calls, 2);
  assert.equal(outcome.results.length, 1);
  assert.equal(outcome.costUsd, 0.00075);
  assert.equal(outcome.results[0].summary, "");
});

test("empty search results are free", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  const outcome = await search("key", { query: "q" }, { fetchImpl: fakeFetch });
  assert.equal(outcome.billable, false);
  assert.equal(outcome.costUsd, 0);
});

test("401 is reported as an auth problem, not a generic API error", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ error: { message: "invalid token" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  await assert.rejects(
    () => search("bad", { query: "q" }, { fetchImpl: fakeFetch }),
    (error: unknown) => {
      assert.ok(error instanceof DeepSeekError);
      assert.equal(error.kind, "auth");
      assert.match(errorHint(error, { path: "search" }), /\/login/);
      return true;
    },
  );
});

test("rate limiter holds concurrent callers under the window", async () => {
  const limiter = new RateLimiter(4);
  const started = Date.now();
  await Promise.all(Array.from({ length: 8 }, () => limiter.acquire()));
  const elapsed = Date.now() - started;
  // 8 slots at 4 per second needs at least one full window of waiting.
  assert.ok(elapsed >= 900, `expected throttling, saw ${elapsed}ms`);
});
