import test from "node:test";
import assert from "node:assert/strict";
import { clearSystemProxyCache, proxyEnvFromSettings, withSystemProxy } from "../src/adapters/systemProxy.ts";

test("one address for everything (v2rayN / Clash style)", () => {
  const env = proxyEnvFromSettings({ enabled: true, server: "127.0.0.1:10808", override: "localhost;127.*;10.*;*.corp.example;<local>" });
  assert.equal(env?.HTTPS_PROXY, "http://127.0.0.1:10808");
  assert.equal(env?.HTTP_PROXY, "http://127.0.0.1:10808");
  assert.deepEqual(env?.NO_PROXY.split(","), ["localhost", "127.0.0.1", "::1", "127.0.0.0/8", "10.0.0.0/8", ".corp.example"]);
  const lan = proxyEnvFromSettings({ enabled: true, server: "127.0.0.1:10808", override: "192.168.*;172.16.*;foo*bar" });
  assert.deepEqual(lan?.NO_PROXY.split(","), ["localhost", "127.0.0.1", "::1", "192.168.0.0/16", "172.16.0.0/16"]);
});

test("per-protocol settings, and socks-only", () => {
  const env = proxyEnvFromSettings({ enabled: true, server: "http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:7892", override: "" });
  assert.equal(env?.HTTPS_PROXY, "http://127.0.0.1:7891");
  assert.equal(env?.HTTP_PROXY, "http://127.0.0.1:7890");
  const socks = proxyEnvFromSettings({ enabled: true, server: "socks=127.0.0.1:1080", override: "" });
  assert.equal(socks?.ALL_PROXY, "socks5://127.0.0.1:1080");
  assert.equal(socks?.HTTPS_PROXY, undefined);
});

test("proxy switched off or empty gives nothing", () => {
  assert.equal(proxyEnvFromSettings({ enabled: false, server: "127.0.0.1:10808", override: "" }), null);
  assert.equal(proxyEnvFromSettings({ enabled: true, server: "  ", override: "" }), null);
  assert.equal(proxyEnvFromSettings(null), null);
});

test("only the desktop app turns it on, and a proxy the user set wins", () => {
  const before = process.env.XGENT_SYSTEM_PROXY;
  try {
    delete process.env.XGENT_SYSTEM_PROXY;
    const env = { PATH: "x" };
    assert.equal(withSystemProxy(env), env, "dev server / open-source version unchanged");
    process.env.XGENT_SYSTEM_PROXY = "1";
    clearSystemProxyCache();
    const own = { PATH: "x", https_proxy: "http://mine:1" };
    assert.equal(withSystemProxy(own), own, "user's own proxy is kept as is");
  } finally {
    if (before === undefined) delete process.env.XGENT_SYSTEM_PROXY;
    else process.env.XGENT_SYSTEM_PROXY = before;
  }
});

test("PAC mode: the proxy address is taken from the PAC script", async () => {
  const { proxyFromPac } = await import("../src/adapters/systemProxy.ts");
  // v2rayN 生成的 PAC 的写法
  const v2rayn = `var proxy = "PROXY 127.0.0.1:10809; SOCKS5 127.0.0.1:10808; DIRECT;";\nfunction FindProxyForURL(url, host) { if (isPlainHostName(host)) return "DIRECT"; return proxy; }`;
  assert.equal(proxyFromPac(v2rayn), "127.0.0.1:10809");
  // 只有 SOCKS 的
  assert.equal(proxyFromPac(`function FindProxyForURL(u, h) { return "SOCKS5 127.0.0.1:7891; DIRECT"; }`), "socks=127.0.0.1:7891");
  // 只有 DIRECT、或者注释里提到 PROXY 但没有地址
  assert.equal(proxyFromPac(`// PROXY settings\nfunction FindProxyForURL(u, h) { return "DIRECT"; }`), null);
});
