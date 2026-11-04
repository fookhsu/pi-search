/**
 * URL safety for `web_read`.
 *
 * The interesting attack is not the URL the caller typed — it is the one a redirect or a
 * DNS answer leads to. So every hop is checked here, and curl is pinned with `--resolve`
 * to the address that was checked; a second DNS answer cannot rebind it afterwards.
 *
 * The pin needs a direct connection. When http_proxy/https_proxy/all_proxy is set, curl
 * hands the host name to the proxy and the proxy resolves it, so the pin is inert — the
 * URL and redirect checks still hold, but the address guarantee does not. `/deepseek doctor`
 * reports which mode is in force.
 *
 * Nothing in this file touches the network except the resolver, which is injectable so
 * the decisions can be tested offline.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface LookupRecord {
  address: string;
  family: number;
}

/** Injected in tests; the default asks the system resolver once per hop. */
export type Lookup = (hostname: string) => Promise<LookupRecord[]>;

/**
 * `policy` means the target was refused on purpose; `unresolvable` only means the name has
 * no address here. The difference decides whether a redirect stops the read or merely fails.
 */
export type BlockRefusal = "policy" | "unresolvable";

export class BlockedUrlError extends Error {
  readonly host: string;
  readonly refusal: BlockRefusal;

  constructor(message: string, options: { host?: string; refusal?: BlockRefusal } = {}) {
    super(message);
    this.name = "BlockedUrlError";
    this.host = options.host ?? "";
    this.refusal = options.refusal ?? "policy";
  }
}

/** Names that never legitimately mean "a page on the public web". */
const BLOCKED_NAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "instance-data",
  "metadata.google.internal",
]);

const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".intranet",
  ".lan",
  ".home.arpa",
];

function ipv4Octets(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255) ? octets : null;
}

function isPublicIpv4(address: string): boolean {
  const octets = ipv4Octets(address);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, incl. cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && octets[2] === 0) return false; // IETF protocol assignments
  if (a === 192 && b === 0 && octets[2] === 2) return false; // TEST-NET-1
  if (a === 192 && b === 88 && octets[2] === 99) return false; // deprecated 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && octets[2] === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && octets[2] === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** Expand an IPv6 address into eight 16-bit words, or null when it is not parseable. */
export function ipv6Words(address: string): number[] | null {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const parse = (part: string): number[] | null => {
    if (!part) return [];
    const words: number[] = [];
    for (const group of part.split(":")) {
      const v4 = ipv4Octets(group);
      if (v4) {
        words.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      words.push(Number.parseInt(group, 16));
    }
    return words;
  };

  const head = parse(halves[0]);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;

  const tail = parse(halves[1]);
  if (!tail) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function embeddedIpv4(words: number[], at: number): string {
  return [
    (words[at] >> 8) & 0xff,
    words[at] & 0xff,
    (words[at + 1] >> 8) & 0xff,
    words[at + 1] & 0xff,
  ].join(".");
}

function isPublicIpv6(address: string): boolean {
  const words = ipv6Words(address);
  if (!words) return false;
  const [w0, w1, w2, w3, w4, w5] = words;

  // Everything that carries an IPv4 address inside is judged by that IPv4 address — the
  // whole point of these forms is to smuggle one in. That covers ::/96 (deprecated
  // IPv4-compatible, and :: / ::1), ::ffff:0:0/96 (mapped), ::ffff:0:0:0/96 (translated),
  // 64:ff9b::/96 and 64:ff9b:1::/48 (NAT64) and 2002::/16 (6to4).
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0)
    return isPublicIpv4(embeddedIpv4(words, 6));
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff)
    return isPublicIpv4(embeddedIpv4(words, 6));
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0xffff && w5 === 0)
    return isPublicIpv4(embeddedIpv4(words, 6));
  if (w0 === 0x64 && w1 === 0xff9b) return isPublicIpv4(embeddedIpv4(words, 6));
  if (w0 === 0x2002) return isPublicIpv4(embeddedIpv4(words, 1));

  if ((w0 & 0xffc0) === 0xfe80) return false; // link-local
  if ((w0 & 0xffc0) === 0xfec0) return false; // deprecated site-local
  if ((w0 & 0xfe00) === 0xfc00) return false; // unique local
  if ((w0 & 0xff00) === 0xff00) return false; // multicast
  if (w0 === 0x2001 && w1 === 0x0db8) return false; // documentation
  if (w0 === 0x100 && w1 === 0 && w2 === 0 && w3 === 0) return false; // discard-only
  return true;
}

/** True only for globally routable addresses; anything ambiguous counts as blocked. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

export interface FetchTarget {
  /** The URL that was approved, with no fragment. */
  url: string;
  hostname: string;
  port: string;
  /** The address curl is pinned to, so the DNS answer cannot change under us. */
  address: string;
}

function bareHostname(url: URL): string {
  return url.hostname.replace(/^\[/, "").replace(/\]$/, "");
}

function assertNameOkay(hostname: string): void {
  const name = hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_NAMES.has(name) || BLOCKED_SUFFIXES.some((suffix) => name.endsWith(suffix)))
    throw new BlockedUrlError(`${name} is a local or internal host name`, { host: name });
  if (!name.includes(".") && !name.includes(":"))
    throw new BlockedUrlError(`${name} has no dot, so it can only resolve inside this network`, { host: name });
}

export const systemLookup: Lookup = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address, family: record.family }));
};

/**
 * Decide whether a URL may be fetched, and return the address to pin it to.
 * Throws BlockedUrlError with a reason the caller can show the model.
 */
export async function resolveFetchTarget(
  rawUrl: string,
  options: { lookup?: Lookup } = {},
): Promise<FetchTarget> {
  if (typeof rawUrl !== "string" || rawUrl.length > 8192)
    throw new BlockedUrlError("the URL must be at most 8192 characters");

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError("not a valid absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new BlockedUrlError(`${url.protocol} is not HTTP(S)`, { host: bareHostname(url) });
  if (url.username || url.password)
    throw new BlockedUrlError("URLs with a username or password are not fetched", { host: bareHostname(url) });

  const hostname = bareHostname(url);
  if (!hostname) throw new BlockedUrlError("the URL has no host");

  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const literal = isIP(hostname);
  if (literal) {
    if (!isPublicAddress(hostname))
      throw new BlockedUrlError(`${hostname} is a loopback, private, link-local or reserved address`, {
        host: hostname,
      });
    return { url: url.toString(), hostname, port, address: hostname };
  }

  assertNameOkay(hostname);

  const lookup = options.lookup ?? systemLookup;
  let records: LookupRecord[];
  try {
    records = await lookup(hostname);
  } catch (error) {
    throw new BlockedUrlError(
      `${hostname} did not resolve (${error instanceof Error ? error.message : String(error)})`,
      { host: hostname, refusal: "unresolvable" },
    );
  }
  if (!records.length)
    throw new BlockedUrlError(`${hostname} did not resolve`, { host: hostname, refusal: "unresolvable" });

  // 0.0.0.0 and :: are what DNS blocklists (and some resolvers, asked for AAAA) answer with;
  // they cannot be a destination, so they are dropped unless they are all there is.
  const usable = records.filter((record) => record.address !== "0.0.0.0" && record.address !== "::");
  if (!usable.length)
    throw new BlockedUrlError(`${hostname} has no routable address (the answer was 0.0.0.0 or ::)`, {
      host: hostname,
      refusal: "unresolvable",
    });

  // Refuse the whole host if any remaining address is internal: a mixed answer is either a
  // misconfiguration or an attack, and picking the "good" record would be a race.
  const blocked = usable.find((record) => !isPublicAddress(record.address));
  if (blocked)
    throw new BlockedUrlError(
      `${hostname} resolves to ${blocked.address}, which is a loopback, private, link-local or reserved address`,
      { host: hostname },
    );

  return { url: url.toString(), hostname, port, address: usable[0].address };
}

/** The `curl --resolve` argument that pins `host` to the address that was checked. */
export function resolveArgument(target: FetchTarget): string {
  const address = isIP(target.address) === 6 ? `[${target.address}]` : target.address;
  return `${target.hostname}:${target.port}:${address}`;
}
