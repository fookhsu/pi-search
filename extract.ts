/** Turning raw HTTP payloads into something an agent can read cheaply. */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  hellip: "…",
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
  copy: "©",
  reg: "®",
  trade: "™",
  middot: "·",
  times: "×",
  laquo: "«",
  raquo: "»",
  deg: "°",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,7});/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** The search index appends `#1`, `#2` fragments that are not real page anchors. */
export function cleanResultUrl(url: string): string {
  return url.replace(/#\d+$/, "");
}

/** Drop later duplicates; the index often lists the same page once per snippet. */
export function dedupeByUrl<T extends { url: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = cleanResultUrl(item.url).replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** Cheap signal that a page is a client-side shell rather than readable text. */
export function looksLikeShell(html: string, extractedChars: number): boolean {
  if (extractedChars >= 800) return false;
  const scripts = (html.match(/<script\b/gi) || []).length;
  const frameworks =
    /__NEXT_DATA__|__NUXT__|window\.__INITIAL_STATE__|id="(?:root|app|__next)"|data-reactroot/i.test(
      html,
    );
  return scripts > 0 || frameworks;
}

export function isPdf(buffer: string | Uint8Array): boolean {
  if (typeof buffer === "string") return buffer.slice(0, 5) === "%PDF-";
  return buffer.length > 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46;
}

const JUNK_CLASS =
  /(?:nav|menu|sidebar|footer|header|banner|cookie|consent|breadcrumb|share|toolbar|social|promo|newsletter|subscribe|related|toc|table-of-contents|vector-toc|mw-body-header|jump|skip-link|advert)/i;

const TAG = /<[a-zA-Z/!][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/g;

function stripChrome(html: string): string {
  let out = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    // data-* attributes can carry whole JSON documents (Wikipedia does exactly that).
    .replace(/\sdata-[\w:.-]+=(?:"[^"]*"|'[^']*')/gi, "")
    .replace(/<(script|style|noscript|template|svg|canvas|iframe|form)\b[\s\S]*?<\/\1>/gi, " ");

  // Pick the densest semantic container, then clean furniture out of whatever we picked.
  const candidates = [
    out.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1],
    out.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1],
    out.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1],
    out,
  ];
  const chosen = candidates.find((candidate) => (candidate ?? "").replace(TAG, "").trim().length > 400) ?? out;

  return chosen
    .replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(div|section|ul|ol|span|p)\b[^>]*(?:id|class)="[^"]*"[^>]*>[\s\S]*?<\/\1>/gi, (block) =>
      JUNK_CLASS.test(block.slice(0, block.indexOf(">"))) ? " " : block,
    );
}

function resolveUrl(href: string, base?: string): string {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#") || /^(?:javascript|mailto|tel|data):/i.test(trimmed)) return "";
  if (!base) return trimmed;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return trimmed;
  }
}

function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Convert HTML to Markdown without dependencies.
 *
 * Deliberately crude: it keeps headings, links, lists, code and tables — enough for an
 * agent to read docs and answers — and throws away chrome. It never renders JavaScript.
 */
export function htmlToMarkdown(html: string, options: { baseUrl?: string } = {}): string {
  const base = options.baseUrl;
  let out = stripChrome(html);

  out = out
    .replace(/<pre\b[^>]*>\s*<code\b[^>]*>/gi, "<pre>")
    .replace(/<\/code>\s*<\/pre>/gi, "</pre>")
    .replace(/<pre\b[^>]*>/gi, "\n\n```\n")
    .replace(/<\/pre>/gi, "\n```\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\b[^>]*>/gi, "\n\n---\n\n")
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, level: string) => `\n\n${"#".repeat(Number(level))} `)
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "")
    .replace(/<\/?(?:ul|ol)\b[^>]*>/gi, "\n")
    .replace(/<blockquote\b[^>]*>/gi, "\n> ")
    .replace(/<\/blockquote>/gi, "\n\n")
    .replace(/<(?:strong|b)\b[^>]*>/gi, "**")
    .replace(/<\/(?:strong|b)>/gi, "**")
    .replace(/<(?:em|i)\b[^>]*>/gi, "*")
    .replace(/<\/(?:em|i)>/gi, "*")
    .replace(/<code\b[^>]*>/gi, "`")
    .replace(/<\/code>/gi, "`")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const url = resolveUrl(href, base);
      const text = label.replace(/<[^>]+>/g, "").trim();
      if (!url) return text;
      return text ? `[${text}](${url})` : `<${url}>`;
    })
    .replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi, (_m, alt: string) => (alt ? `![${alt}]` : ""))
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/?(?:table|thead|tbody|tr|td|th)\b[^>]*>/gi, "")
    .replace(/<\/(?:p|div|section|article|figure|pre|dl|dd|dt)>/gi, "\n\n")
    .replace(/<(?:p|div|section|article|figure)\b[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(TAG, "");

  return tidy(decodeEntities(out));
}

export interface Slice {
  chunk: string;
  total: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
}

/** Page through a document so one fetch cannot flood the context window. */
export function sliceContent(content: string, offset = 0, maxChars = 20000): Slice {
  const total = content.length;
  const start = Math.max(0, Math.min(offset, total));
  const end = Math.min(total, start + Math.max(1, maxChars));
  return {
    chunk: content.slice(start, end),
    total,
    offset: start,
    hasMore: end < total,
    nextOffset: end < total ? end : null,
  };
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]`;
}

export function isoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}
