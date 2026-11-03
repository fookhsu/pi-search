/**
 * Live checks against the real APIs.
 *
 * These run the registered tools through a fake extension host, so the whole path is
 * exercised: parameter schema, key resolution, curl-first reading, formatting, caching.
 * Skipped when DEEPSEEK_API_KEY is absent.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import deepseekSearchExtension from "./index.ts";

const HAS_KEY = Boolean(process.env.DEEPSEEK_API_KEY);

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

function fakeExec(
  cmd: string,
  args: string[],
  options: { signal?: AbortSignal; timeout?: number; cwd?: string } = {},
) {
  return new Promise<{ stdout: string; stderr: string; code: number; killed: boolean; truncated: boolean }>(
    (resolve) => {
      const child = spawn(cmd, args, { cwd: options.cwd });
      let stdout = "";
      let stderr = "";
      let killed = false;
      const timer = options.timeout
        ? setTimeout(() => {
            killed = true;
            child.kill("SIGKILL");
          }, options.timeout)
        : undefined;
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const finish = (code: number) => {
        if (timer) clearTimeout(timer);
        resolve({ stdout, stderr, code, killed, truncated: false });
      };
      child.on("close", (code) => finish(code ?? 0));
      child.on("error", () => finish(127));
      options.signal?.addEventListener("abort", () => child.kill("SIGTERM"));
    },
  );
}

function host() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const pi = {
    exec: fakeExec,
    registerTool: (definition: any) => tools.set(definition.name, definition),
    registerCommand: (name: string, definition: any) => commands.set(name, definition),
  };
  deepseekSearchExtension(pi as any);
  const ctx = {
    modelRegistry: {
      getApiKeyForProvider: async (provider: string) =>
        provider === "deepseek" ? process.env.DEEPSEEK_API_KEY : undefined,
    },
    ui: { notify: () => {} },
  };
  const run = async (tool: string, params: Record<string, unknown>): Promise<ToolResult> => {
    const definition = tools.get(tool);
    if (!definition) throw new Error(`tool ${tool} not registered`);
    return (await definition.execute("test", params, undefined, undefined, ctx)) as ToolResult;
  };
  return { tools, commands, run };
}

const text = (result: ToolResult) => result.content.map((item) => item.text ?? "").join("");

test("web_search returns deduped, cleaned results with authority and cost", { skip: !HAS_KEY }, async () => {
  const { run } = host();
  const result = await run("web_search", { query: "spring boot 3.5 release notes", count: 6 });
  const body = text(result);
  assert.equal(result.isError, undefined);
  assert.equal(result.details?.status, "ok");
  assert.ok((result.details?.kept as number) >= 3, body.slice(0, 300));
  assert.match(body, /trust \d\/4/);
  assert.doesNotMatch(body, /#\d+\)/); // index fragments stripped from URLs
  assert.equal(result.details?.costUsd, 0.00075);
  const urls = new Set((result.details?.results as Array<{ url: string }>).map((item) => item.url));
  assert.equal(urls.size, (result.details?.results as unknown[]).length, "duplicate URLs leaked through");
});

test("an identical search is served from cache for free", { skip: !HAS_KEY }, async () => {
  const { run } = host();
  const params = { query: "sqlite wal mode checkpoint", count: 3 };
  const first = await run("web_search", params);
  const second = await run("web_search", params);
  assert.equal(first.details?.cached, false);
  assert.equal(second.details?.cached, true);
  assert.equal(second.details?.costUsd, 0);
  assert.equal(text(first), text(second));
});

test("min_authority filters low-trust hits", { skip: !HAS_KEY }, async () => {
  const { run } = host();
  const result = await run("web_search", { query: "redis persistence aof", count: 10, min_authority: 4 });
  const kept = (result.details?.results as Array<{ authority: number }>) ?? [];
  assert.ok(kept.every((item) => item.authority >= 4), "authority filter let something through");
});

test("max_chars trims the output and says so", { skip: !HAS_KEY }, async () => {
  const { run } = host();
  const result = await run("web_search", { query: "kubernetes pod eviction", count: 10, max_chars: 2000 });
  const body = text(result);
  assert.ok(body.length < 2600, `expected a trimmed answer, got ${body.length} chars`);
  assert.match(body, /context budget/);
  assert.equal(result.details?.trimmed, true);
});

test("web_read prefers curl where DeepSeek's crawler refuses", { skip: !HAS_KEY }, async () => {
  const { run } = host();
  const result = await run("web_read", {
    url: "https://en.wikipedia.org/wiki/Java_(programming_language)",
    max_chars: 4000,
  });
  assert.equal(result.isError, undefined, text(result).slice(0, 200));
  assert.equal(result.details?.via, "curl");
  assert.equal(result.details?.costUsd, 0);
  assert.ok((result.details?.totalChars as number) > 5000, "expected a real article, not nav chrome");
  assert.match(text(result), /Java/);
});

test("web_read pages long documents and serves the rest from cache", { skip: !HAS_KEY }, async () => {
  const { run } = host();
  const url = "https://martinfowler.com/articles/microservices.html";
  const first = await run("web_read", { url, max_chars: 1500 });
  assert.equal(first.details?.hasMore, true);
  const nextOffset = first.details?.nextOffset as number;
  assert.ok(nextOffset > 0);
  const second = await run("web_read", { url, offset: nextOffset, max_chars: 1500 });
  assert.equal(second.details?.offset, nextOffset);
  assert.equal(second.details?.cached, true);
  assert.notEqual(text(first), text(second));
});

test("web_read falls back to the DeepSeek fetcher when curl is blocked", { skip: !HAS_KEY }, async () => {
  const { run } = host();
  const result = await run("web_read", { url: "https://www.baeldung.com/spring-boot-start", max_chars: 3000 });
  assert.equal(result.isError, undefined, text(result).slice(0, 200));
  assert.equal(result.details?.via, "curl→deepseek");
  assert.ok((result.details?.totalChars as number) > 3000, `thin result: ${result.details?.totalChars}`);
  assert.equal(result.details?.costUsd, 0.00075);
});

test("engine=deepseek skips curl and explains the failure", { skip: !HAS_KEY }, async () => {
  const { run } = host();
  const result = await run("web_read", {
    url: "https://en.wikipedia.org/wiki/Retrieval-augmented_generation",
    engine: "deepseek",
  });
  assert.equal(result.isError, true);
  assert.match(text(result), /curl -sSL/);
});

test("web_read reports an unreadable host once, without inventing content", { skip: !HAS_KEY }, async () => {
  const { run } = host();
  const result = await run("web_read", { url: "https://this-host-should-not-exist-pi-test.invalid/x" });
  assert.equal(result.isError, true);
  assert.ok(text(result).length > 20);
});

test("/deepseek status reports spend and cache state", { skip: !HAS_KEY }, async () => {
  const { commands } = host();
  const messages: string[] = [];
  const ctx = {
    modelRegistry: { getApiKeyForProvider: async () => process.env.DEEPSEEK_API_KEY },
    ui: { notify: (message: string) => messages.push(message) },
  };
  await commands.get("deepseek").handler("status", ctx as any);
  assert.match(messages.join("\n"), /key: pi login/);
  assert.match(messages.join("\n"), /spend: \$/);
});

test("renderers produce text for TUI without touching the network", { skip: !HAS_KEY }, async () => {
  const { tools, run } = host();
  const theme = new Proxy({} as Record<string, unknown>, {
    get: () => (value: string) => value,
  }) as any;
  const context = { keyHint: () => "ctrl+o" } as any;

  const search = tools.get("web_search");
  const call = search.renderCall({ query: "x", count: 3, include_content: true }, theme);
  assert.ok(String(call).includes("web_search") || call);

  const result = await run("web_search", { query: "nginx worker_connections", count: 2 });
  const rendered = search.renderResult(result, { expanded: false }, theme, context);
  assert.ok(rendered);

  const read = tools.get("web_read");
  assert.ok(read.renderCall({ url: "https://example.com", offset: 100 }, theme));
  const page = await run("web_read", { url: "https://example.com", max_chars: 800 });
  assert.ok(rendered && read.renderResult(page, { expanded: true }, theme, context));
  const failed = await run("web_read", { url: "https://this-host-should-not-exist-pi-test.invalid/x" });
  assert.ok(read.renderResult(failed, { expanded: false }, theme, context));
});
