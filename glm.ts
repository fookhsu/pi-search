/**
 * Transport for Zhipu's (GLM) standalone Web Search API.
 *
 * Reuses the plugin's error type, rate limiter and result shape: the failure handling and
 * rendering in index.ts are built around DeepSeekError and SearchResult, and a second error
 * class for one endpoint would be a second abstraction nobody asked for.
 *
 * Endpoint: POST https://open.bigmodel.cn/api/paas/v4/web_search (docs.bigmodel.cn, Web
 * Search API). Differences from DeepSeek that are respected, not papered over:
 * - query is capped at 70 characters and has no site:/lang:/date operators;
 * - domain filtering is a whitelist string (search_domain_filter), there is no blocklist;
 * - results carry no authority score, so min_authority filtering drops everything.
 */

import { setTimeout as delay } from "node:timers/promises";
import {
  DeepSeekError,
  type ErrorKind,
  limiter,
  type SearchResult,
  validateDomains,
} from "./api.ts";

const GLM_SEARCH_URL = "https://open.bigmodel.cn/api/paas/v4/web_search";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;

/**
 * Listed prices (元/次) per engine, from docs.bigmodel.cn/cn/guide/tools/web-search.
 * Converted to USD at a fixed approximation so the shared spend tally stays meaningful;
 * the exact rate moves, the order of magnitude does not.
 */
export const GLM_PRICE_CNY = {
  search_std: 0.01,
  search_pro: 0.03,
  search_pro_sogou: 0.05,
  search_pro_quark: 0.05,
} as const;
const CNY_PER_USD = 7.2;

export type GlmEngine = keyof typeof GLM_PRICE_CNY;

export interface GlmSearchInput {
  query: string;
  count?: number;
  allowed_domains?: string[];
  blocked_domains?: string[];
  include_content?: boolean;
  engine?: GlmEngine;
}

interface GlmHit {
  title?: string;
  content?: string;
  link?: string;
  media?: string;
  icon?: string;
  refer?: string;
  publish_date?: string;
}

export function buildGlmSearchRequest(input: GlmSearchInput): {
  search_query: string;
  search_engine: GlmEngine;
  search_intent: boolean;
  count?: number;
  search_domain_filter?: string;
  content_size?: "high";
} {
  const query = (input.query ?? "").trim();
  if (!query) throw new DeepSeekError("query must not be blank.", { kind: "invalid" });
  if (Array.from(query).length > 70)
    throw new DeepSeekError(
      "query must be at most 70 characters for GLM (BigModel limit); shorten it.",
      { kind: "invalid" },
    );
  if (input.blocked_domains?.length)
    throw new DeepSeekError("GLM web_search has no domain blocklist; use allowed_domains instead.", {
      kind: "invalid",
    });
  const allowed = validateDomains(input.allowed_domains, "allowed_domains");
  if (input.count !== undefined && (!Number.isInteger(input.count) || input.count < 1 || input.count > 50))
    throw new DeepSeekError("count must be an integer between 1 and 50.", { kind: "invalid" });

  const engine = input.engine ?? "search_std";
  return {
    search_query: query,
    search_engine: engine,
    // Required by the API; false = search directly instead of gating on intent detection.
    search_intent: false,
    ...(input.count === undefined ? {} : { count: input.count }),
    ...(allowed.length ? { search_domain_filter: allowed.join(",") } : {}),
    ...(input.include_content ? { content_size: "high" as const } : {}),
  };
}

function classify(status: number, message: string): DeepSeekError {
  const kind: ErrorKind =
    status === 401 || status === 403
      ? "auth"
      : status === 402
        ? "balance"
        : status === 429
          ? "rate_limit"
          : status === 400
            ? "invalid"
            : "api";
  return new DeepSeekError(message || `HTTP ${status}`, { kind, status });
}

/** Actionable text for GLM-origin failures; DeepSeek hints name the wrong key. */
export function glmErrorHint(error: DeepSeekError): string {
  switch (error.kind) {
    case "auth":
      return "The GLM API key is missing or rejected. Get one at open.bigmodel.cn and export GLM_API_KEY (or ZAI_API_KEY), or run /login in Pi and pick Z.AI.";
    case "balance":
      return "The BigModel account has no balance. Top up at bigmodel.cn, or drop provider:\"glm\" to search with DeepSeek.";
    case "rate_limit":
      return "Rate limited by BigModel after retries. Space out searches, or wait a moment and retry.";
    case "network":
      return "The request never reached open.bigmodel.cn. Check the network path, then retry.";
    default:
      return "Unexpected GLM API failure; retry once, then fall back to provider:\"deepseek\" or bash + curl.";
  }
}

export interface GlmSearchOutcome {
  results: SearchResult[];
  billable: boolean;
  costUsd: number;
  engine: GlmEngine;
}

export async function glmSearch(
  apiKey: string,
  input: GlmSearchInput,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<GlmSearchOutcome> {
  const body = buildGlmSearchRequest(input);
  const fetchImpl = options.fetchImpl ?? fetch;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      await limiter.acquire(options.signal);
      const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
      response = await fetchImpl(GLM_SEARCH_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (attempt < MAX_ATTEMPTS - 1) {
        await delay(500 * 2 ** attempt, undefined, options.signal ? { signal: options.signal } : undefined);
        continue;
      }
      throw new DeepSeekError(
        `Network error reaching open.bigmodel.cn: ${error instanceof Error ? error.message : String(error)}`,
        { kind: "network" },
      );
    }

    if (response.status === 200) {
      const data = (await response.json()) as { search_result?: GlmHit[] };
      const hits = Array.isArray(data?.search_result) ? data.search_result : [];
      const results = hits.map((hit) => ({
        title: hit.title ?? "",
        url: hit.link ?? "",
        snippet: hit.content ?? "",
        summary: hit.content ?? "",
        // BigModel returns a summary, not a page body; the formatter falls back to it.
        content: "",
        site_name: hit.media ?? null,
        site_icon: hit.icon ?? null,
        date: hit.publish_date ?? null,
        // No authority concept on this API; 0 renders without a trust tag.
        authority: 0,
        rerank_score: 0,
      }));
      // Unlike DeepSeek, BigModel prices every successful call (元/次), empty or not.
      const billable = true;
      return {
        results,
        billable,
        costUsd: billable ? GLM_PRICE_CNY[body.search_engine] / CNY_PER_USD : 0,
        engine: body.search_engine,
      };
    }

    if ((response.status === 408 || response.status === 429 || response.status >= 500) && attempt < MAX_ATTEMPTS - 1) {
      await response.body?.cancel();
      await delay(500 * 2 ** attempt, undefined, options.signal ? { signal: options.signal } : undefined);
      continue;
    }

    let detail = response.statusText;
    try {
      const data = (await response.json()) as { error?: { message?: string } };
      detail = data.error?.message || detail;
    } catch {
      /* Some failures return a non-JSON body. */
    }
    throw classify(response.status, detail);
  }
  throw new DeepSeekError(`GLM search failed after ${MAX_ATTEMPTS} attempts.`, { kind: "api" });
}
