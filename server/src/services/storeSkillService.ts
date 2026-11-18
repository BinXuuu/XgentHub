import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import { ProxyAgent } from "undici";
import { config } from "../config.ts";
import { parseSkillFrontmatter } from "./githubSkillService.ts";
import { createResourceLibraryItem, listResourceLibraryItems } from "./resourceLibraryService.ts";
import { currentVersion } from "./updateService.ts";
import { extractZip } from "./zipExtract.ts";

// 商店订阅源（卖 Skill 的官网）的接口客户端，和「从商店下载 Skill」。
// 接口都在商店地址下（比如 https://…/api/xgent/v1），返回 JSON，出错时是 { error, message }。
// Xgent 里没有任何支付代码：付款在官网完成，这里只负责读目录、打开结算页、查已购、下载已购的 Skill。

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
const proxyDispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

const MAX_ZIP_BYTES = 50 * 1024 * 1024;
const SOURCE_FILE = "XGENT-SOURCE.json";

export class StoreApiError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function isLoopback(url: URL) {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

async function storeFetch(url: string, init: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const target = new URL(url);
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
      ...(proxyDispatcher && !isLoopback(target) ? { dispatcher: proxyDispatcher } : {}),
    } as RequestInit);
  } catch (err) {
    throw new Error(`连不上商店 ${target.origin}（${(err as Error).name === "TimeoutError" ? "没有及时响应" : (err as Error).message}），请确认官网已经打开、地址没写错`);
  }
}

const SYSTEM_NAME: Record<string, string> = { win32: "Windows", darwin: "macOS", linux: "Linux" };

function clientInfo(): string {
  return `Xgent ${currentVersion()} (${os.hostname()}; ${SYSTEM_NAME[process.platform] ?? process.platform})`;
}

/** 调商店接口。pathname 以 / 开头，接在商店地址后面。 */
export async function storeRequest<T>(base: string, pathname: string, options: { method?: string; token?: string | null; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  // 商店的「已授权设备」页显示 X-Xgent-Client。
  const headers: Record<string, string> = { "User-Agent": "XgentHub-store", "X-Xgent-Client": clientInfo(), Accept: "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await storeFetch(`${base.replace(/\/+$/, "")}${pathname}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    timeoutMs: options.timeoutMs,
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 下面按状态码报错 */ }
  const error = data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string" ? (data as { error: string; message?: string }) : null;
  if (!res.ok || error) {
    const code = error?.error ?? (res.status === 401 ? "unauthorized" : `http_${res.status}`);
    const message = error?.message || (res.status === 401 ? "登录已失效，请重新连接官网账号" : res.status === 403 ? "没有权限（还没购买？）" : `商店返回 HTTP ${res.status}`);
    throw new StoreApiError(message, code, res.status);
  }
  if (data === null) throw new Error("商店返回的不是 JSON");
  return data as T;
}

export function storeSkillsRoot(): string {
  return path.join(config.dataDir, "skills", "store");
}

function safeSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+/, "_") || "_";
}

/** 某个商店 Skill 安装后 SKILL.md 所在的位置。 */
export function storeSkillEntryPath(sourceId: string, itemId: string): string {
  return path.join(storeSkillsRoot(), safeSegment(sourceId), safeSegment(itemId), "SKILL.md");
}

function pathKey(value: string): string {
  return process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
}

/** zip 解开后 Skill 所在的目录：根目录直接有 SKILL.md，或者只有一个文件夹、里面有 SKILL.md。 */
function findSkillDir(root: string, files: string[]): string {
  if (files.includes("SKILL.md")) return root;
  const tops = new Set(files.map((file) => file.split("/")[0]));
  if (tops.size === 1) {
    const top = [...tops][0]!;
    if (files.includes(`${top}/SKILL.md`)) return path.join(root, top);
  }
  throw new Error("压缩包里没有找到 SKILL.md（应该是一个文件夹，里面有 SKILL.md）");
}

interface DownloadTicket { url: string; sha256: string; size: number; version: string; fileName?: string }

export interface StoreSkillInstallResult {
  targetId: string;
  action: "installed" | "updated";
  version: string;
  warnings: string[];
}

/** 下载并安装一个已购的商店 Skill：拿签名链接 → 下载 zip → 校验大小和 sha256 → 解压 → 登记进技能库。 */
export async function installStoreSkill(input: {
  base: string;
  token: string;
  sourceId: string;
  itemId: string;
  name: string;
  license?: string;
  groupId: string | null;
}): Promise<StoreSkillInstallResult> {
  const ticket = await storeRequest<DownloadTicket>(input.base, `/skills/${encodeURIComponent(input.itemId)}/download`, { method: "POST", token: input.token, body: {} });
  if (!ticket || typeof ticket.url !== "string" || !/^https?:\/\//i.test(ticket.url)) throw new Error("商店没有给出下载地址");
  if (typeof ticket.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(ticket.sha256)) throw new Error("商店没有给出文件校验值");
  if (typeof ticket.size === "number" && ticket.size > MAX_ZIP_BYTES) throw new Error(`安装包太大（上限 ${MAX_ZIP_BYTES / 1024 / 1024} MB）`);
  // 签名链接本身就是凭证，可能在别的域名（对象存储），不带登录令牌。
  const res = await storeFetch(ticket.url, { headers: { "User-Agent": "XgentHub-store" }, timeoutMs: 120_000 });
  if (!res.ok) throw new Error(`下载安装包失败：HTTP ${res.status}${res.status === 403 ? "（下载链接可能已过期，请重试）" : ""}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_ZIP_BYTES) throw new Error(`安装包太大（上限 ${MAX_ZIP_BYTES / 1024 / 1024} MB）`);
  const zip = Buffer.from(await res.arrayBuffer());
  if (zip.length > MAX_ZIP_BYTES) throw new Error(`安装包太大（上限 ${MAX_ZIP_BYTES / 1024 / 1024} MB）`);
  if (typeof ticket.size === "number" && ticket.size !== zip.length) throw new Error("安装包大小和商店给的不一致，可能下载不完整，请重试");
  const sha256 = crypto.createHash("sha256").update(zip).digest("hex");
  if (sha256 !== ticket.sha256.toLowerCase()) throw new Error("安装包校验失败（sha256 不一致），已放弃安装");

  const entry = storeSkillEntryPath(input.sourceId, input.itemId);
  const dest = path.dirname(entry);
  const temp = `${dest}.tmp-${nanoid(6)}`;
  try {
    const files = extractZip(zip, temp);
    const skillDir = findSkillDir(temp, files);
    const frontmatter = parseSkillFrontmatter(fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8"));
    fs.writeFileSync(path.join(skillDir, SOURCE_FILE), `${JSON.stringify({
      store: input.base,
      sourceId: input.sourceId,
      itemId: input.itemId,
      version: ticket.version,
      sha256,
      installedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    // 全部解压成功才替换旧版本，失败不会留下半个 Skill。
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const old = `${dest}.old-${nanoid(6)}`;
    if (fs.existsSync(dest)) fs.renameSync(dest, old);
    fs.renameSync(skillDir, dest);
    fs.rmSync(old, { recursive: true, force: true });

    const existing = listResourceLibraryItems("skill").find((item) => item.sourcePath && pathKey(item.sourcePath) === pathKey(entry));
    // 更新时文件已换成新版本；技能库里的名称、说明和归组保留用户的编辑。
    if (existing) return { targetId: existing.id, action: "updated", version: ticket.version, warnings: [] };
    const item = createResourceLibraryItem("skill", {
      title: frontmatter.name?.trim() || input.name,
      content: frontmatter.description?.trim() || `从商店购买的 Skill「${input.name}」，使用前先读取 SKILL.md。`,
      tags: ["商店", ...(input.license ? [input.license] : [])],
      groupId: input.groupId,
      sourcePath: entry,
    });
    return { targetId: item.id, action: "installed", version: ticket.version, warnings: [] };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/** 删除技能库条目时，顺带删掉从商店下载到数据目录里的文件；其它来源的文件不动。 */
export function removeStoreSkillFiles(sourcePath: string | null | undefined): boolean {
  if (!sourcePath) return false;
  const dir = path.dirname(path.resolve(sourcePath));
  const relative = path.relative(storeSkillsRoot(), dir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  if (!fs.existsSync(path.join(dir, SOURCE_FILE))) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
