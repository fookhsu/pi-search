/**
 * Transport for DeepSeek's standalone Search and Fetch APIs.
 *
 * Everything here is deliberately small: validation, a shared rate limiter, retry with
 * backoff, and error mapping that tells the caller what to do next instead of a bare 404.
 */

import { setTimeout as delay } from "node:timers/promises";

const API_BASE = "https://api.deepseek.com/v1/tools";
const BALANCE_URL = "https://api.deepseek.com/user/balance";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;

/** Documented price: $0.75 per 1,000 successful requests. */
export const PRICE_PER_SUCCESSFUL_REQUEST_USD = 0.00075;

/** The account limit is 5 QPS for search and 5 QPS for fetch; stay just under it. */
const MAX_QPS = 4.5;

export type ErrorKind =
  | "auth"
  | "balance"
  | "rate_limit"
  | "unavailable"
  | "invalid"
  | "network"
  | "api";

export class DeepSeekError extends Error {
  readonly kind: ErrorKind;
  readonly status: number;
  readonly requestId?: string;

  constructor(message: string, options: { kind: ErrorKind; status?: number; requestId?: string }) {
    super(message);
    this.name = "DeepSeekError";
    this.kind = options.kind;
    this.status = options.status ?? 0;
    this.requestId = options.requestId;
  }
}

function requestIdOf(message: string): string | undefined {
  return message.match(/request_id:\s*([0-9a-zA-Z-]+)/)?.[1];
}

function classify(status: number, message: string): DeepSeekError {
  const requestId = requestIdOf(message);
  const clean = message.replace(/\s*\(request_id:[^)]*\)/, "").trim();
  const kind: ErrorKind =
    status === 401 || status === 403
      ? "auth"
      : status === 402
        ? "balance"
        : status === 429
          ? "rate_limit"
          : status === 404
            ? "unavailable"
            : status === 400
              ? "invalid"
              : "api";
  return new DeepSeekError(clean || `HTTP ${status}`, { kind, status, requestId });
}

/** Actionable text the model can act on; this is the whole point of typing the errors. */
export function errorHint(error: DeepSeekError, context: { path: "search" | "fetch"; url?: string }): string {
  switch (error.kind) {
    case "auth":
      return "The DeepSeek API key is missing or rejected. Run /login in Pi and pick DeepSeek, or set DEEPSEEK_API_KEY.";
    case "balance":
      return "The DeepSeek account has no balance. Top up, or use a different engine for this request.";
    case "rate_limit":
      return "Rate limited after retries. Space out searches, or wait a moment and retry.";
    case "unavailable":
      return context.path === "fetch"
        ? `The DeepSeek fetcher cannot read this page (it answers 404 whenever its crawler is blocked or finds no extractable text, which covers Wikipedia, Stack Overflow, Hacker News, raw.githubusercontent.com and most login walls). Read it with bash instead: curl -sSL '${context.url ?? "<url>"}' | head -c 20000`
        : "No usable index for this query. Rephrase, or drop the site:/date operators.";
    case "invalid":
      return "The request was rejected as invalid; shorten the query or check the domain filters.";
    case "network":
      return "The request never reached DeepSeek. Check the network path, then retry.";
    default:
      return "Unexpected DeepSeek API failure; retry once, then fall back to bash + curl.";
  }
}

/** Sliding-window limiter shared by both tools so concurrent calls stay under the account cap. */
export class RateLimiter {
  private stamps: number[] = [];
  private readonly qps: number;

  constructor(qps = MAX_QPS) {
    this.qps = qps;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    const windowMs = 1000;
    const capacity = Math.max(1, Math.floor(this.qps));
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter((stamp) => now - stamp < windowMs);
      if (this.stamps.length < capacity) {
        this.stamps.push(now);
        return;
      }
      const waitMs = windowMs - (now - this.stamps[0]) + 5;
      await delay(waitMs, undefined, { signal });
    }
  }
}

export const limiter = new RateLimiter();

export interface SearchInput {
  query: string;
  count?: number;
  allowed_domains?: string[];
  blocked_domains?: string[];
  include_content?: boolean;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  summary: string;
  content: string;
  site_name: string | null;
  site_icon: string | null;
  date: string | null;
  /** 1-4 in practice; higher is more authoritative. */
  authority: number;
  rerank_score: number;
}

export interface FetchPage {
  title: string;
  content: string;
}

function charCount(value: string): number {
  return Array.from(value).length;
}

function validateText(value: string, label: string, max = 128): void {
  if (typeof value !== "string" || !value.trim() || charCount(value) > max) {
    throw new DeepSeekError(`${label} must contain 1 to ${max} characters and cannot be blank.`, {
      kind: "invalid",
    });
  }
}

export function validateDomains(domains: string[] | undefined, label: string): string[] {
  if (!domains) return [];
  if (!Array.isArray(domains)) throw new DeepSeekError(`${label} must be a list of domain names.`, { kind: "invalid" });
  for (const domain of domains) {
    if (
      typeof domain !== "string" ||
      domain.length > 253 ||
      !/^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)*[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(domain)
    ) {
      throw new DeepSeekError(`${label} must contain plain domain names without schemes or paths.`, {
        kind: "invalid",
      });
    }
  }
  return domains;
}

export function buildSearchRequest(input: SearchInput): {
  query: string;
  count?: number;
  need_content?: boolean;
} {
  validateText(input.query, "query");
  const allowed = validateDomains(input.allowed_domains, "allowed_domains");
  const blocked = validateDomains(input.blocked_domains, "blocked_domains");
  if (allowed.length && blocked.length)
    throw new DeepSeekError("allowed_domains and blocked_domains cannot be combined.", { kind: "invalid" });

  let query = input.query.trim();
  if (allowed.length) query += ` site:${allowed.join(" OR site:")}`;
  if (blocked.length) query += ` ${blocked.map((domain) => `-site:${domain}`).join(" ")}`;
  validateText(query, "query with domain filters");

  if (input.count !== undefined) {
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > 50)
      throw new DeepSeekError("count must be an integer between 1 and 50.", { kind: "invalid" });
  }

  return {
    query,
    ...(input.count === undefined ? {} : { count: input.count }),
    ...(input.include_content ? { need_content: true } : {}),
  };
}

export function validateFetchUrl(url: string): void {
  if (typeof url !== "string" || url.length > 8192)
    throw new DeepSeekError("url must be at most 8192 characters.", { kind: "invalid" });
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DeepSeekError("url must be a valid HTTP(S) URL with a host.", { kind: "invalid" });
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password)
    throw new DeepSeekError("url must be an HTTP(S) URL with a host and without a username or password.", {
      kind: "invalid",
    });
}

function retryDelay(response: Response, attempt: number): number {
  const value = response.headers.get("retry-after");
  const seconds = value === null ? Number.NaN : Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5000);
  if (value) {
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 5000);
  }
  return 500 * 2 ** attempt;
}

async function postJson<T>(
  path: "search" | "fetch",
  apiKey: string,
  body: object,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // The abort signal a caller passes aborts the whole call; each attempt gets its own timeout.
  const outer = options.signal;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = outer ? AbortSignal.any([outer, timeout]) : timeout;
    let response: Response;
    try {
      await limiter.acquire(outer);
      response = await fetchImpl(`${API_BASE}/${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: requestSignal,
      });
    } catch (error) {
      if (outer?.aborted) throw error;
      if (attempt < MAX_ATTEMPTS - 1) {
        await delay(500 * 2 ** attempt, undefined, outer ? { signal: outer } : undefined);
        continue;
      }
      throw new DeepSeekError(
        `Network error reaching api.deepseek.com: ${error instanceof Error ? error.message : String(error)}`,
        { kind: "network" },
      );
    }

    if (response.status === 200) return (await response.json()) as T;

    if ((response.status === 408 || response.status === 429 || response.status >= 500) && attempt < MAX_ATTEMPTS - 1) {
      await response.body?.cancel();
      await delay(retryDelay(response, attempt), undefined, outer ? { signal: outer } : undefined);
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
  throw new DeepSeekError(`DeepSeek ${path} failed after ${MAX_ATTEMPTS} attempts.`, { kind: "api" });
}

export interface SearchOutcome {
  results: SearchResult[];
  billable: boolean;
  costUsd: number;
}

export async function search(
  apiKey: string,
  input: SearchInput,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<SearchOutcome> {
  const request = buildSearchRequest(input);
  const data = await postJson<{ results: SearchResult[] }>("search", apiKey, request, options);
  if (!Array.isArray(data?.results))
    throw new DeepSeekError("DeepSeek Search returned an invalid results payload.", { kind: "api" });
  const results = data.results.map((item) => ({
    ...item,
    snippet: item.snippet ?? "",
    summary: item.summary ?? "",
    content: item.content ?? "",
    date: item.date ?? null,
  }));
  const billable = results.length > 0;
  return { results, billable, costUsd: billable ? PRICE_PER_SUCCESSFUL_REQUEST_USD : 0 };
}

export interface FetchOutcome {
  page: FetchPage;
  billable: boolean;
  costUsd: number;
}

export async function fetchPage(
  apiKey: string,
  url: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<FetchOutcome> {
  validateFetchUrl(url);
  const page = await postJson<FetchPage>("fetch", apiKey, { url }, options);
  if (typeof page?.title !== "string" || typeof page?.content !== "string")
    throw new DeepSeekError("DeepSeek Fetch returned an invalid page payload.", { kind: "api" });
  const billable = page.content.length > 0;
  return { page, billable, costUsd: billable ? PRICE_PER_SUCCESSFUL_REQUEST_USD : 0 };
}

export interface Balance {
  available: boolean;
  currency: string | null;
  total: string | null;
}

/** Free endpoint; used by the /deepseek command. */
export async function getBalance(
  apiKey: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<Balance> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(BALANCE_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: options.signal ?? AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw classify(response.status, response.statusText);
  const data = (await response.json()) as {
    is_available?: boolean;
    balance_infos?: Array<{ currency?: string; total_balance?: string }>;
  };
  const info = data.balance_infos?.[0];
  return {
    available: Boolean(data.is_available),
    currency: info?.currency ?? null,
    total: info?.total_balance ?? null,
  };
}
