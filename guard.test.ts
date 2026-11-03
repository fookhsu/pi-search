import assert from "node:assert/strict";
import test from "node:test";
import {
  BlockedUrlError,
  ipv6Words,
  isPublicAddress,
  resolveArgument,
  resolveFetchTarget,
  type Lookup,
} from "./guard.ts";

const publicLookup: Lookup = async () => [{ address: "93.184.216.34", family: 4 }];
const neverCalled: Lookup = async () => {
  throw new Error("the resolver should not have been consulted");
};

test("isPublicAddress blocks the IPv4 ranges an SSRF probe reaches for", () => {
  for (const address of [
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.1",
    "172.16.5.4",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "192.0.2.10",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "203.0.114.1"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test("isPublicAddress blocks loopback, link-local, ULA and mapped IPv6", () => {
  for (const address of [
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "64:ff9b::7f00:1", // NAT64 wrapping 127.0.0.1
    "2002:0a00:0001::1", // 6to4 wrapping 10.0.1.x
    "[::1]",
  ]) {
    const bare = address.replace(/^\[|\]$/g, "");
    assert.equal(isPublicAddress(bare), false, address);
  }
  for (const address of ["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test("ipv6Words expands shorthand, embedded IPv4 and zone ids", () => {
  assert.deepEqual(ipv6Words("::1"), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(ipv6Words("fe80::1%en0"), [0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(ipv6Words("::ffff:127.0.0.1"), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001]);
  assert.equal(ipv6Words("2001:db8::1::2"), null);
  assert.equal(ipv6Words("nonsense"), null);
});

test("resolveFetchTarget refuses loopback, metadata and private literals", async () => {
  for (const url of [
    "http://127.0.0.1/",
    "http://127.0.0.1:8080/admin",
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    "http://10.0.0.1/",
    "http://[::1]/",
    "http://2130706433/", // decimal 127.0.0.1, normalised by the URL parser
    "http://0x7f.1/",
    "http://localhost:3000/",
    "http://api.localhost/",
    "http://printer.local/",
    "http://intranet/wiki",
  ]) {
    await assert.rejects(resolveFetchTarget(url, { lookup: neverCalled }), BlockedUrlError, url);
  }
});

test("resolveFetchTarget refuses non-HTTP schemes and credentials", async () => {
  for (const url of [
    "file:///etc/passwd",
    "ftp://example.com/x",
    "gopher://example.com:70/1",
    "javascript:alert(1)",
    "http://user:secret@example.com/",
    "not a url",
    "",
  ]) {
    await assert.rejects(resolveFetchTarget(url, { lookup: neverCalled }), BlockedUrlError, url);
  }
});

test("resolveFetchTarget refuses a host whose DNS answer lands inside the network", async () => {
  const mixed: Lookup = async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "169.254.169.254", family: 4 },
  ];
  await assert.rejects(resolveFetchTarget("https://metadata.example.test/", { lookup: mixed }), BlockedUrlError);

  const empty: Lookup = async () => [];
  await assert.rejects(resolveFetchTarget("https://example.test/", { lookup: empty }), BlockedUrlError);

  const failing: Lookup = async () => {
    throw new Error("ENOTFOUND");
  };
  await assert.rejects(resolveFetchTarget("https://example.test/", { lookup: failing }), BlockedUrlError);
});

test("resolveFetchTarget approves a public host and pins the checked address", async () => {
  const target = await resolveFetchTarget("HTTPS://Example.TEST/docs?q=1#frag", { lookup: publicLookup });
  assert.equal(target.hostname, "example.test");
  assert.equal(target.port, "443");
  assert.equal(target.address, "93.184.216.34");
  assert.equal(resolveArgument(target), "example.test:443:93.184.216.34");
});

test("an explicit port and an IPv6 literal keep the pin well formed", () => {
  assert.equal(
    resolveArgument({ url: "http://x", hostname: "example.test", port: "8080", address: "2606:4700::1111" }),
    "example.test:8080:[2606:4700::1111]",
  );
});

test("literal public IPs skip the resolver entirely", async () => {
  const target = await resolveFetchTarget("http://93.184.216.34/", { lookup: neverCalled });
  assert.equal(target.address, "93.184.216.34");
  assert.equal(resolveArgument(target), "93.184.216.34:80:93.184.216.34");
});
