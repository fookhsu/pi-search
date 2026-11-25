import assert from "node:assert/strict";
import test from "node:test";
import { DeepSeekError } from "./api.ts";
import {
  type GlmSearchOutcome,
  buildGlmSearchRequest,
  glmErrorHint,
  glmSearch,
} from "./glm.ts";

function glmResponse(hits: unknown[]): Response {
  return new Response(JSON.stringify({ id: "x", search_result: hits }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("buildGlmSearchRequest maps the shared input onto BigModel's fields", () => {
  assert.deepEqual(buildGlmSearchRequest({ query: "  rust async  " }), {
    search_query: "rust async",
    search_engine: "search_std",
    search_intent: false,
  });
  assert.deepEqual(buildGlmSearchRequest({ query: "rust", count: 5 }), {
    search_query: "rust",
    search_engine: "search_std",
    search_intent: false,
    count: 5,
  });
  // allowed_domains becomes the whitelist string; blocked_domains is refused outright.
  assert.deepEqual(buildGlmSearchRequest({ query: "rust", allowed_domains: ["docs.rs", "crates.io"] }), {
    search_query: "rust",
    search_engine: "search_std",
    search_intent: false,
    search_domain_filter: "docs.rs,crates.io",
  });
  assert.deepEqual(buildGlmSearchRequest({ query: "rust", include_content: true }), {
    search_query: "rust",
    search_engine: "search_std",
    search_intent: false,
    content_size: "high",
  });
});

test("buildGlmSearchRequest rejects what BigModel cannot express", () => {
  assert.throws(() => buildGlmSearchRequest({ query: "   " }), /blank/);
  assert.throws(() => buildGlmSearchRequest({ query: "字".repeat(71) }), /70 characters/);
  // 70 CJK characters is exactly at the limit.
  assert.doesNotThrow(() => buildGlmSearchRequest({ query: "字".repeat(70) }));
  assert.throws(
    () => buildGlmSearchRequest({ query: "rust", blocked_domains: ["csdn.net"] }),
    /no domain blocklist/,
  );
  assert.throws(() => buildGlmSearchRequest({ query: "rust", count: 0 }), DeepSeekError);
  assert.throws(() => buildGlmSearchRequest({ query: "rust", count: 51 }), DeepSeekError);
  assert.throws(
    () => buildGlmSearchRequest({ query: "rust", allowed_domains: ["https://a.com/path"] }),
    /plain domain names/,
  );
});

test("glmSearch maps BigModel hits onto the shared result shape", async () => {
  const fetchImpl = (async () =>
    glmResponse([
      {
        title: "Rust async",
        content: "a summary",
        link: "https://blog.test/rust",
        media: "blog.test",
        icon: "https://blog.test/f.ico",
        publish_date: "2026-11-20 10:00:00",
      },
    ])) as unknown as typeof fetch;

  const outcome: GlmSearchOutcome = await glmSearch("key", { query: "rust" }, { fetchImpl });
  assert.equal(outcome.engine, "search_std");
  assert.equal(outcome.results.length, 1);
  const result = outcome.results[0];
  assert.equal(result.title, "Rust async");
  assert.equal(result.url, "https://blog.test/rust");
  assert.equal(result.summary, "a summary");
  assert.equal(result.site_name, "blog.test");
  assert.equal(result.authority, 0, "GLM has no authority concept");
  // Every successful call is priced: search_std is 0.01 CNY ≈ $0.00139.
  assert.equal(outcome.costUsd, 0.01 / 7.2);
});

test("glmSearch passes the engine through and prices accordingly", async () => {
  let body = "";
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    body = String(init.body);
    return glmResponse([]);
  }) as unknown as typeof fetch;

  const outcome = await glmSearch("key", { query: "知乎 rust", engine: "search_pro_sogou" }, { fetchImpl });
  assert.match(body, /"search_engine":"search_pro_sogou"/);
  assert.equal(outcome.costUsd, 0.05 / 7.2);
});

test("glmSearch classifies failures with actionable hints", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error: { message: "invalid token" } }), { status: 401 })) as unknown as typeof fetch;
  const error = await glmSearch("bad", { query: "q" }, { fetchImpl }).catch((e) => e);
  assert.ok(error instanceof DeepSeekError);
  assert.equal(error.kind, "auth");
  assert.match(glmErrorHint(error), /GLM_API_KEY/);

  const balanceHint = glmErrorHint(new DeepSeekError("no money", { kind: "balance", status: 402 }));
  assert.match(balanceHint, /Top up/);
});

test("glmSearch retries transient 5xx and succeeds", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) return new Response("boom", { status: 503, headers: { "retry-after": "0" } });
    return glmResponse([{ title: "t", link: "https://a.test" }]);
  }) as unknown as typeof fetch;

  const outcome = await glmSearch("key", { query: "q" }, { fetchImpl });
  assert.equal(calls, 2);
  assert.equal(outcome.results.length, 1);
});

test("glmSearch rejects a blank body instead of inventing results", async () => {
  const fetchImpl = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(() => glmSearch("key", { query: "q" }, { fetchImpl }));
});
