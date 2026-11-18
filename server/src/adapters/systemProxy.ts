import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 把 Windows 的「系统代理」交给各个 Agent 的命令行。
 *
 * 很多人访问 Anthropic / OpenAI / Google 要开代理软件（v2rayN、Clash 之类），这些软件通常只设置「系统代理」：
 * 浏览器认，命令行不认。结果是浏览器里登录好了，Claude Code 换验证码时直连 Anthropic，被拒绝（403 Request not allowed），
 * 跑任务也一样连不上。2026-11-10 在测试电脑上实测：直连 403，走 127.0.0.1:10808 后正常。
 *
 * 只在应用版里打开（XGENT_SYSTEM_PROXY=1，由安装版的主进程设置），开源版 / 本机开发服务行为不变。
 * 用户自己设了 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY 的话，一律以用户的为准，不覆盖。
 * 每次启动命令时现读（带 10 秒缓存），代理软件晚于 Xgent 启动、或者中途开关代理都能跟上。
 * 代理软件的「PAC 模式」：系统里只有一个 PAC 脚本地址（AutoConfigURL），命令行不会执行 PAC。这时把脚本取回来，
 * 用里面写的代理地址（「PROXY 127.0.0.1:10809」之类）。Agent 要连的都是国外服务，全部走这个代理没有问题；本机和局域网照样直连。
 */

const INTERNET_SETTINGS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const PROXY_VARS = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"];

export interface SystemProxySettings {
  enabled: boolean;
  server: string;
  override: string;
  /** PAC 脚本地址（代理软件的 PAC 模式）。 */
  autoConfigUrl?: string;
}

let cache: { at: number; value: Record<string, string> | null } | null = null;

function readRegistry(): SystemProxySettings | null {
  try {
    const out = execFileSync("reg.exe", ["query", INTERNET_SETTINGS_KEY], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const value = (name: string) => out.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, "mi"))?.[1]?.trim() ?? "";
    return {
      enabled: /^0x0*1$/i.test(value("ProxyEnable")),
      server: value("ProxyServer"),
      override: value("ProxyOverride"),
      autoConfigUrl: value("AutoConfigURL"),
    };
  } catch {
    return null;
  }
}

/**
 * 从 PAC 脚本里找代理地址：优先 HTTP 代理（PROXY / HTTPS），没有再用 SOCKS。
 * 返回系统代理设置里 ProxyServer 的写法（「127.0.0.1:10809」或「socks=127.0.0.1:10808」），找不到返回 null。
 */
export function proxyFromPac(script: string): string | null {
  const found = [...script.matchAll(/\b(PROXY|HTTPS|SOCKS5|SOCKS4|SOCKS)\s+([\w.-]+|\[[0-9a-f:]+\]):(\d{1,5})\b/gi)].map((m) => ({
    type: m[1].toUpperCase(),
    address: `${m[2]}:${m[3]}`,
  }));
  const http = found.find((item) => item.type === "PROXY" || item.type === "HTTPS");
  if (http) return http.address;
  const socks = found.find((item) => item.type.startsWith("SOCKS"));
  return socks ? `socks=${socks.address}` : null;
}

/** 取回 PAC 脚本（最多等 3 秒；取脚本本身不走代理）。 */
function fetchPac(url: string): string | null {
  try {
    if (/^file:/i.test(url)) return fs.readFileSync(fileURLToPath(url), "utf8");
    if (!/^https?:\/\//i.test(url)) return null;
    return execFileSync("curl.exe", ["-s", "-f", "-m", "3", "--noproxy", "*", url], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** 系统代理设置（包括 PAC 模式）→ 实际要用的代理设置。 */
function resolveSettings(settings: SystemProxySettings | null): SystemProxySettings | null {
  if (!settings) return null;
  if (settings.enabled && settings.server.trim()) return settings;
  if (!settings.autoConfigUrl) return null;
  const script = fetchPac(settings.autoConfigUrl);
  const server = script ? proxyFromPac(script) : null;
  return server ? { ...settings, enabled: true, server } : null;
}

function withScheme(address: string, scheme: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `${scheme}://${address}`;
}

/** 系统代理设置 → 命令行认的环境变量。没开代理、或者只有 PAC 时返回 null。 */
export function proxyEnvFromSettings(settings: SystemProxySettings | null): Record<string, string> | null {
  if (!settings?.enabled || !settings.server.trim()) return null;
  const server = settings.server.trim();
  const env: Record<string, string> = {};
  if (server.includes("=")) {
    // 按协议分开设置：「http=127.0.0.1:7890;https=127.0.0.1:7890;socks=127.0.0.1:7891」
    const parts = new Map<string, string>();
    for (const item of server.split(";")) {
      const [scheme, address] = item.split("=").map((part) => part.trim());
      if (scheme && address) parts.set(scheme.toLowerCase(), address);
    }
    const http = parts.get("https") ?? parts.get("http");
    if (http) {
      env.HTTPS_PROXY = withScheme(http, "http");
      env.HTTP_PROXY = withScheme(parts.get("http") ?? http, "http");
    } else if (parts.get("socks")) {
      env.ALL_PROXY = withScheme(parts.get("socks")!, "socks5");
    } else {
      return null;
    }
  } else {
    env.HTTPS_PROXY = withScheme(server, "http");
    env.HTTP_PROXY = env.HTTPS_PROXY;
  }
  // 本机地址永远直连：Claude / Codex 登录时浏览器要回调本机，MCP 也常开在本机。
  const noProxy = new Set(["localhost", "127.0.0.1", "::1"]);
  for (const raw of settings.override.split(";")) {
    const item = raw.trim();
    if (!item || item === "<local>") continue;
    // 代理软件常写「192.168.*」「10.*」这种局域网网段：换成 192.168.0.0/16 的写法，局域网里的 MCP、NAS 不绕代理。
    const subnet = item.match(/^(\d{1,3}(?:\.\d{1,3}){0,2})\.\*$/);
    if (subnet) {
      const octets = subnet[1].split(".");
      noProxy.add(`${[...octets, ...Array(4 - octets.length).fill("0")].join(".")}/${octets.length * 8}`);
    } else if (item.startsWith("*.")) noProxy.add(item.slice(1));
    else if (!item.includes("*")) noProxy.add(item);
  }
  env.NO_PROXY = [...noProxy].join(",");
  return env;
}

function currentProxyEnv(): Record<string, string> | null {
  if (cache && Date.now() - cache.at < 10_000) return cache.value;
  const value = proxyEnvFromSettings(resolveSettings(readRegistry()));
  cache = { at: Date.now(), value };
  return value;
}

/** 给要启动的命令行补上系统代理（只在应用版、Windows 上，且用户自己没设代理时）。 */
export function withSystemProxy(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv | undefined {
  if (process.platform !== "win32" || process.env.XGENT_SYSTEM_PROXY !== "1") return env;
  const base = env ?? process.env;
  const keys = Object.keys(base).map((key) => key.toUpperCase());
  if (PROXY_VARS.some((name) => keys.includes(name))) return env;
  const proxy = currentProxyEnv();
  if (!proxy) return env;
  const noProxy = Object.keys(base).find((key) => key.toUpperCase() === "NO_PROXY");
  return { ...base, ...proxy, ...(noProxy ? { NO_PROXY: base[noProxy]! } : {}) };
}

/** 测试用：清掉 10 秒缓存。 */
export function clearSystemProxyCache(): void {
  cache = null;
}
