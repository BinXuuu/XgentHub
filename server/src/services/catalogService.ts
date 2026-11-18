import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import { ProxyAgent } from "undici";
import { config } from "../config.ts";
import { readJsonFile, writeJsonAtomic } from "./jsonStore.ts";
import { githubSkillEntryPath, installGithubSkills } from "./githubSkillService.ts";
import { installStoreSkill, StoreApiError, storeRequest } from "./storeSkillService.ts";
import { createMcpServer, getMcpServer, updateMcpServer, type McpServerInput } from "./mcpServerService.ts";
import {
  createResourceLibraryItem,
  checkResourceGroupId,
  moveResourcesToGroup,
  getResourceLibraryItemsByIds,
  listResourceLibraryItems,
  updateResourceLibraryItem,
} from "./resourceLibraryService.ts";

// 推荐目录：从订阅源（一个 JSON 文件）读出整理好的 Skill / MCP / 工具，一键装进 Xgent。
// 内置的官方源默认读 GitHub 上的 catalog/catalog.json，读不到时用随程序附带的同一个文件；
// 用户还可以加别的源（以后的会员目录就是一个带访问密钥的源）。装过什么、装的哪个版本记在 catalog-installs.json。
// 「商店」源是卖 Skill 的官网：目录里带价格和「已拥有」，买过的 Skill 从商店下载 zip 安装（接口见 storeSkillService.ts）。

export type CatalogKind = "skill" | "mcp" | "tool";

export interface CatalogInput {
  key: string;
  label: string;
  help?: string;
  placeholder?: string;
  secret?: boolean;
  required?: boolean;
  default?: string;
}

export interface CatalogItem {
  id: string;
  kind: CatalogKind;
  group?: string;
  version: string;
  name: string;
  summary: string;
  tags?: string[];
  license?: string;
  homepage?: string;
  /** 商店源的 Skill 没有 source，从商店下载。 */
  source?: { type: "github"; repo: string; ref?: string; path: string };
  mcp?: { transport: "stdio" | "http"; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> };
  tool?: { content: string; command?: string };
  inputs?: CatalogInput[];
  /** 以下只有商店源有：价格（分）、币种、当前账号是否已购买、官网详情页。 */
  priceCents?: number;
  currency?: string;
  owned?: boolean;
  detailUrl?: string;
}

interface CatalogFile {
  version: number;
  name?: string;
  description?: string;
  updatedAt?: string;
  /** 目录的网页（商店官网首页之类），推荐页上「去官网看更多」用。 */
  url?: string;
  /** url：这一组在网页上的完整列表，推荐页只露前几个，其余点过去看。 */
  groups?: Array<{ id: string; name: string; description?: string; url?: string }>;
  items?: CatalogItem[];
}

export type CatalogSourceType = "catalog" | "store";

export interface StoreAccount {
  id: string;
  email: string;
  displayName: string;
}

export interface CatalogSource {
  id: string;
  /** 不写就是普通目录文件。 */
  type?: CatalogSourceType;
  name: string;
  /** 普通源是目录文件地址；商店源是商店接口地址（比如 https://…/api/xgent/v1）。 */
  url: string;
  /** 访问密钥（会员目录用）或商店登录令牌，发请求时放在 Authorization: Bearer 里。 */
  key: string | null;
  /** 商店源连接的官网账号。 */
  account?: StoreAccount | null;
  builtin: boolean;
  enabled: boolean;
}

interface InstallRecord {
  kind: CatalogKind;
  version: string;
  targetId: string;
  /** 安装时内容的指纹；跟现在的内容不一样说明用户改过，更新前要确认。 */
  hash: string;
  inputs: Record<string, string>;
  installedAt: string;
}

export type CatalogItemStatus = "not_installed" | "installed" | "update";

export interface CatalogItemView extends CatalogItem {
  sourceId: string;
  status: CatalogItemStatus;
  installedVersion: string | null;
  /** 上次安装填的非密钥参数，更新时预填。 */
  savedInputs: Record<string, string>;
}

export interface CatalogSourceView {
  id: string;
  type: CatalogSourceType;
  name: string;
  url: string;
  hasKey: boolean;
  builtin: boolean;
  enabled: boolean;
  catalogName: string | null;
  description: string | null;
  updatedAt: string | null;
  /** 读远程失败、用了随程序附带的版本时为 true。 */
  bundled: boolean;
  error: string | null;
  /** 商店源：连接的官网账号（不含令牌）。 */
  account: { email: string; displayName: string } | null;
  /** 目录的网页：目录文件里的 url；商店没写时用商店地址的域名。 */
  homeUrl: string | null;
}

export interface CatalogTotals {
  /** 每类一共多少条（含没发给页面的商店条目）。 */
  kinds: Record<CatalogKind, number>;
  /** 每个分组一共多少条，键是「订阅源 id::分组 id」。 */
  groups: Record<string, number>;
  /** 搜索时商店里一共搜到多少条（页面最多拿 STORE_SEARCH_LIMIT 条）；没搜索时为 null。 */
  storeMatched: number | null;
}

export interface CatalogView {
  sources: CatalogSourceView[];
  groups: Array<{ sourceId: string; id: string; name: string; description: string; url: string | null }>;
  items: CatalogItemView[];
  warnings: string[];
}

export class CatalogConflictError extends Error {
  code = "modified";
}

const BUILTIN_ID = "official";
const STORE_ID = "store";
const DEFAULT_URL = "https://raw.githubusercontent.com/BinXuuu/XgentHub/main/catalog/catalog.json";
const BUNDLED_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../catalog/catalog.json");
const CACHE_MS = 10 * 60 * 1000;
/** 商店目录可能有上万条、几 MB，给足时间。 */
const CATALOG_TIMEOUT_MS = 60_000;
/** 推荐页上商店每组只给前几个，其余去官网看；搜索时最多给这么多条。 */
export const STORE_PREVIEW = 8;
export const STORE_SEARCH_LIMIT = 120;
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
const proxyDispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

function sourcesPath() { return path.join(config.dataDir, "catalog-sources.json"); }
function installsPath() { return path.join(config.dataDir, "catalog-installs.json"); }

function builtinSources(): CatalogSource[] {
  const sources: CatalogSource[] = [{ id: BUILTIN_ID, name: "Xgent 官方推荐", url: process.env.XGENT_CATALOG_URL?.trim() || DEFAULT_URL, key: null, builtin: true, enabled: true }];
  // 内置商店：设置了 XGENT_STORE_URL 才出现。
  const storeUrl = process.env.XGENT_STORE_URL?.trim();
  if (storeUrl) sources.push({ id: STORE_ID, type: "store", name: "Xgent 商店", url: storeUrl, key: null, account: null, builtin: true, enabled: true });
  return sources;
}

function readSources(): CatalogSource[] {
  const saved = readJsonFile<CatalogSource[]>(sourcesPath(), []).filter(Boolean);
  const builtins = builtinSources().map((source) => {
    const state = saved.find((entry) => entry.id === source.id);
    // 内置商店的地址来自环境变量，可能换过（本机开发的官网 → 正式官网）：令牌只对拿到它的那个地址有效，
    // 地址对不上就当没连接，免得把一个站的令牌发给另一个站。
    const sameUrl = state?.url === source.url;
    return source.type === "store"
      ? { ...source, enabled: state?.enabled ?? true, key: sameUrl ? state?.key ?? null : null, account: sameUrl ? state?.account ?? null : null }
      : { ...source, enabled: state?.enabled ?? true };
  });
  return [...builtins, ...saved.filter((source) => source.id !== BUILTIN_ID && source.id !== STORE_ID)];
}

function writeSources(sources: CatalogSource[]) {
  // 内置源只保存开关状态（内置商店还有登录令牌），地址始终用程序里的默认值（或环境变量）。
  writeJsonAtomic(sourcesPath(), sources.map((source) => !source.builtin ? source
    : source.type === "store" ? { id: source.id, enabled: source.enabled, url: source.url, key: source.key, account: source.account ?? null }
    : { id: source.id, enabled: source.enabled }));
}

function isStore(source: CatalogSource) {
  return source.type === "store";
}

function readInstalls(): Record<string, InstallRecord> {
  return readJsonFile<Record<string, InstallRecord>>(installsPath(), {});
}

function recordKey(sourceId: string, itemId: string) { return `${sourceId}::${itemId}`; }

function hashOf(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function isLocalPath(url: string) {
  return /^file:/i.test(url) || path.isAbsolute(url);
}

async function fetchCatalogText(source: CatalogSource): Promise<string> {
  if (isLocalPath(source.url)) {
    return fs.readFileSync(/^file:/i.test(source.url) ? fileURLToPath(source.url) : source.url, "utf8");
  }
  if (!/^https?:\/\//i.test(source.url)) throw new Error("订阅地址要以 http:// 或 https:// 开头，或者是本机文件路径");
  const headers: Record<string, string> = { "User-Agent": "XgentHub-catalog", Accept: "application/json" };
  if (source.key) headers.Authorization = `Bearer ${source.key}`;
  let res: Response;
  try {
    res = await fetch(source.url, { headers, signal: AbortSignal.timeout(20_000), ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}) } as RequestInit);
  } catch (err) {
    throw new Error(`连不上订阅地址（${(err as Error).name === "TimeoutError" ? "20 秒内没有响应" : (err as Error).message}）`);
  }
  if (res.status === 401 || res.status === 403) throw new Error("访问被拒绝：访问密钥不对或已过期");
  if (!res.ok) throw new Error(`订阅地址返回 HTTP ${res.status}`);
  return res.text();
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/;

/** 校验并整理目录文件；格式不对的条目跳过并给出提示，不让一条坏数据拖垮整个目录。 */
export function parseCatalog(text: string, label: string, options: { store?: boolean } = {}): { file: CatalogFile; items: CatalogItem[]; warnings: string[] } {
  let file: CatalogFile;
  try { file = JSON.parse(text) as CatalogFile; } catch { throw new Error(`${label}：不是合法的 JSON`); }
  if (!file || typeof file !== "object" || file.version !== 1) throw new Error(`${label}：目录格式版本不支持（需要 "version": 1）`);
  const warnings: string[] = [];
  const items: CatalogItem[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(file.items) ? file.items : []) {
    const item = raw as CatalogItem;
    const name = typeof item?.name === "string" ? item.name : String(item?.id ?? "?");
    const problem = (() => {
      if (!item || typeof item.id !== "string" || !SAFE_ID.test(item.id)) return "id 不合法";
      if (seen.has(item.id)) return "id 重复";
      if (typeof item.name !== "string" || !item.name.trim()) return "缺少 name";
      if (typeof item.version !== "string" || !item.version.trim()) return "缺少 version";
      if (options.store && item.kind === "skill") {
        // 商店的 Skill 从商店下载 zip，不看 source。
        if (item.priceCents !== undefined && (!Number.isInteger(item.priceCents) || item.priceCents < 0)) return "priceCents 不合法";
      } else if (item.kind === "skill") {
        const src = item.source;
        if (src?.type !== "github" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(src.repo ?? "") || typeof src.path !== "string") return "skill 需要 source: { type: github, repo, path }";
        if (src.path.split("/").some((part) => part === ".." || part === ".")) return "source.path 不合法";
      } else if (item.kind === "mcp") {
        const mcp = item.mcp;
        if (!mcp || (mcp.transport === "stdio" ? !mcp.command : mcp.transport === "http" ? !mcp.url : true)) return "mcp 需要 transport 和 command / url";
        if ((mcp as { remoteType?: unknown }).remoteType === "sse") return "SSE 协议的远程 MCP 暂不支持";
      } else if (item.kind === "tool") {
        if (!item.tool || typeof item.tool.content !== "string" || !item.tool.content.trim()) return "tool 需要 content";
      } else return `不认识的类型 ${String(item.kind)}`;
      if (item.inputs && (!Array.isArray(item.inputs) || item.inputs.some((input) => !input || !/^[A-Za-z0-9_]+$/.test(input.key ?? "") || !input.label))) return "inputs 格式不对";
      return null;
    })();
    if (problem) { warnings.push(`${label} · ${name}：${problem}，已跳过`); continue; }
    seen.add(item.id);
    const clean: CatalogItem = { ...item, summary: typeof item.summary === "string" ? item.summary : "", tags: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === "string") : [] };
    if (options.store && item.kind === "skill") {
      // 商店的 Skill 只按商店的字段走，不接受夹带的 GitHub 来源、MCP 命令之类。
      delete clean.source; delete clean.mcp; delete clean.tool; delete clean.inputs;
      clean.priceCents = item.priceCents ?? 0;
      clean.currency = typeof item.currency === "string" && item.currency ? item.currency : "CNY";
      clean.owned = item.owned === true;
      clean.detailUrl = webUrl(item.detailUrl) ?? undefined;
    } else if (options.store) {
      // 商店的 MCP / 工具是免费的配置，和普通目录一样直接装，不分买没买；只有在官网加入「我的库」的才标 owned。
      delete clean.source; delete clean.priceCents; delete clean.currency;
      clean.owned = item.owned === true ? true : undefined;
      clean.detailUrl = webUrl(item.detailUrl) ?? undefined;
    } else {
      delete clean.priceCents; delete clean.currency; delete clean.owned; delete clean.detailUrl;
    }
    items.push(clean);
  }
  // 商店条目多，格式不对的也可能很多：只列前几条。
  if (warnings.length > 5) warnings.splice(3, warnings.length - 3, `${label}：还有 ${warnings.length - 3} 条格式不对，已跳过`);
  return { file, items, warnings };
}

const cache = new Map<string, { at: number; url: string; key: string | null; result: { file: CatalogFile; items: CatalogItem[]; warnings: string[]; bundled: boolean } }>();

async function loadSource(source: CatalogSource, force: boolean) {
  const hit = cache.get(source.id);
  if (!force && hit && hit.url === source.url && hit.key === source.key && Date.now() - hit.at < CACHE_MS) return hit.result;
  let result: { file: CatalogFile; items: CatalogItem[]; warnings: string[]; bundled: boolean };
  try {
    result = isStore(source) ? await loadStoreCatalog(source) : { ...parseCatalog(await fetchCatalogText(source), source.name), bundled: false };
  } catch (err) {
    // 官方源连不上时退回随程序附带的目录，离线也能装（Skill 本身仍要能访问 GitHub）。
    // 商店不退：附带的目录不是商店的东西，退回去会和官方推荐重复一份。
    if (!source.builtin || isStore(source) || !fs.existsSync(BUNDLED_PATH)) throw err;
    result = { ...parseCatalog(fs.readFileSync(BUNDLED_PATH, "utf8"), source.name), bundled: true };
    result.warnings.unshift(`${source.name}：${(err as Error).message}，暂时显示随程序附带的目录`);
  }
  cache.set(source.id, { at: Date.now(), url: source.url, key: source.key, result });
  return result;
}

async function loadStoreCatalog(source: CatalogSource) {
  if (!/^https?:\/\//i.test(source.url)) throw new Error("商店地址要以 http:// 或 https:// 开头");
  let data: unknown;
  const warnings: string[] = [];
  try {
    data = await storeRequest(source.url, "/catalog", { token: source.key, timeoutMs: CATALOG_TIMEOUT_MS });
  } catch (err) {
    if (!(err instanceof StoreApiError && err.status === 401 && source.key)) throw err;
    // 令牌失效（比如在官网取消了这台设备的授权）：先不带令牌显示目录，提示重新连接。
    data = await storeRequest(source.url, "/catalog", { timeoutMs: CATALOG_TIMEOUT_MS });
    forgetStoreToken(source.id, source.key);
    warnings.push(`${source.name}：官网账号的授权已失效（可能在官网取消了），请点「连接官网账号」重新连接`);
  }
  const parsed = parseCatalog(JSON.stringify(data), source.name, { store: true });
  const seen = seenStoreItems.get(source.url) ?? new Map<string, CatalogItem>();
  for (const item of parsed.items) seen.set(item.id, { ...item });
  seenStoreItems.set(source.url, seen);
  const token = readSources().find((entry) => entry.id === source.id)?.key;
  if (token) await mergeStoreLibrary(source, token, parsed.items, warnings);
  return { ...parsed, warnings: [...warnings, ...parsed.warnings], bundled: false };
}

/** 每个商店地址读到过的条目（只在内存里），目录不再列出已入库的条目时用来补名字。 */
const seenStoreItems = new Map<string, Map<string, CatalogItem>>();

export interface StoreLibrary {
  /** 我的库里每一项的 id（Skill、MCP、工具都算）。 */
  ids: Set<string>;
  /** 商店有 /library 时是完整条目；老商店只有 /purchases，这里是 null。 */
  items: CatalogItem[] | null;
}

/**
 * 读官网「我的库」：优先 GET /library（Skill、MCP、工具的完整条目），
 * 商店没有这个接口（404）就退回 GET /purchases（只有买过 / 领取过的 Skill 的 id）。
 */
export async function fetchStoreLibrary(base: string, token: string, label = "商店"): Promise<StoreLibrary> {
  try {
    const res = await storeRequest<{ items?: unknown[] }>(base, "/library", { token });
    const parsed = parseCatalog(JSON.stringify({ version: 1, items: Array.isArray(res?.items) ? res.items : [] }), `${label}「我的库」`, { store: true });
    for (const item of parsed.items) item.owned = true;
    return { ids: new Set(parsed.items.map((item) => item.id)), items: parsed.items };
  } catch (err) {
    if (!(err instanceof StoreApiError && err.status === 404)) throw err;
  }
  const res = await storeRequest<{ items?: Array<{ skillId?: unknown }> }>(base, "/purchases", { token });
  return { ids: new Set((Array.isArray(res?.items) ? res.items : []).map((item) => String(item?.skillId ?? "")).filter((id) => SAFE_ID.test(id))), items: null };
}

/**
 * 官网「我的库」里有、目录里却没列出的（比如社区开源的几万个 Skill、几万个 MCP 不进目录，
 * 或者商店把已入库的免费 Skill 隐藏了），按「我的库」补上，不然这台电脑上没装过的就找不到安装入口。
 * 查不到「我的库」不影响目录本身。
 */
async function mergeStoreLibrary(source: CatalogSource, token: string, items: CatalogItem[], warnings: string[]) {
  let library: StoreLibrary;
  try { library = await fetchStoreLibrary(source.url, token, source.name); }
  catch (err) {
    if (!(err instanceof StoreApiError && err.status === 401)) warnings.push(`查询官网「我的库」失败：${(err as Error).message}`);
    return;
  }
  const listed = new Map(items.map((item) => [item.id, item]));
  const seen = seenStoreItems.get(source.url) ?? new Map<string, CatalogItem>();
  const full = new Map((library.items ?? []).map((item) => [item.id, item]));
  for (const id of library.ids) {
    const known = listed.get(id);
    if (known) { known.owned = true; continue; }
    // 以前读目录时见过的（比如刚在官网加入库之前），沿用那时的名字和介绍。
    const item: CatalogItem = full.get(id) ?? (seen.get(id) ? { ...seen.get(id)!, owned: true }
      : { id, kind: "skill", version: "1", name: id, summary: "已在官网加入「我的库」（商店没有给出详情）。", tags: [], priceCents: 0, currency: "CNY", owned: true });
    items.push(item);
    listed.set(id, item);
  }
}

/** 清掉某个订阅源的目录缓存（登录、购买之后要重新读「已拥有」）。 */
export function invalidateCatalogCache(sourceId: string) {
  cache.delete(sourceId);
}

function targetExists(record: InstallRecord): boolean {
  if (record.kind === "mcp") return Boolean(getMcpServer(record.targetId));
  return getResourceLibraryItemsByIds(record.kind, [record.targetId]).length > 0;
}

function publicInputs(item: CatalogItem, inputs: Record<string, string>): Record<string, string> {
  const secret = new Set((item.inputs ?? []).filter((input) => input.secret).map((input) => input.key));
  return Object.fromEntries(Object.entries(inputs).filter(([key]) => !secret.has(key)));
}

export async function getCatalog(force = false): Promise<CatalogView> {
  const installs = readInstalls();
  const view: CatalogView = { sources: [], groups: [], items: [], warnings: [] };
  for (const source of readSources()) {
    if (!source.enabled) { view.sources.push(sourceView(source)); continue; }
    let base = sourceView(source);
    try {
      const loaded = await loadSource(source, force);
      // 读商店目录时可能发现令牌失效并清掉了，按最新的显示。
      if (isStore(source)) base = sourceView(readSources().find((entry) => entry.id === source.id) ?? source);
      view.sources.push({ ...base, catalogName: loaded.file.name ?? null, description: loaded.file.description ?? null, updatedAt: loaded.file.updatedAt ?? null, bundled: loaded.bundled, homeUrl: webUrl(loaded.file.url) ?? base.homeUrl });
      view.warnings.push(...loaded.warnings);
      for (const group of loaded.file.groups ?? []) {
        if (group && typeof group.id === "string" && typeof group.name === "string") view.groups.push({ sourceId: source.id, id: group.id, name: group.name, description: group.description ?? "", url: webUrl(group.url) });
      }
      for (const item of loaded.items) {
        const record = installs[recordKey(source.id, item.id)];
        const live = record && targetExists(record) ? record : null;
        view.items.push({
          ...item, sourceId: source.id,
          status: !live ? "not_installed" : live.version === item.version ? "installed" : "update",
          installedVersion: live?.version ?? null,
          savedInputs: live ? publicInputs(item, live.inputs) : {},
        });
      }
    } catch (err) {
      view.sources.push({ ...base, error: (err as Error).message });
    }
  }
  return view;
}

/**
 * 给推荐页用的精简目录：商店动辄上万条，页面只拿每组前几个、「我的库」里没装或有更新的，
 * 以及真实的总数；搜索在这里做，商店的搜索结果最多给 STORE_SEARCH_LIMIT 条。普通目录条目少，全给。
 */
export async function getCatalogPage(force = false, query = ""): Promise<CatalogView & { totals: CatalogTotals }> {
  const view = await getCatalog(force);
  const stores = new Set(view.sources.filter((source) => source.type === "store").map((source) => source.id));
  const text = query.trim().toLowerCase();
  const totals: CatalogTotals = { kinds: { skill: 0, mcp: 0, tool: 0 }, groups: {}, storeMatched: text ? 0 : null };
  const shownPerGroup = new Map<string, number>();
  const items: CatalogItemView[] = [];
  for (const item of view.items) {
    const groupKey = `${item.sourceId}::${item.group ?? ""}`;
    totals.kinds[item.kind]++;
    totals.groups[groupKey] = (totals.groups[groupKey] ?? 0) + 1;
    if (text && ![item.name, item.summary, ...(item.tags ?? [])].join(" ").toLowerCase().includes(text)) continue;
    if (!stores.has(item.sourceId)) { items.push(item); continue; }
    if (text) totals.storeMatched!++;
    if (item.owned === true && item.status !== "installed") { items.push(item); continue; }
    if (text) { if (totals.storeMatched! <= STORE_SEARCH_LIMIT) items.push(item); continue; }
    const shown = (shownPerGroup.get(groupKey) ?? 0) + 1;
    shownPerGroup.set(groupKey, shown);
    if (shown <= STORE_PREVIEW) items.push(item);
  }
  return { ...view, items, totals };
}

function render(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, key: string) => values[key] ?? "");
}

function resolveInputs(item: CatalogItem, given: Record<string, string> | undefined, previous: Record<string, string> | undefined) {
  const values: Record<string, string> = {};
  for (const input of item.inputs ?? []) {
    let value = typeof given?.[input.key] === "string" ? given[input.key]!.trim() : "";
    // 更新时密钥留空就沿用上次填的。
    if (!value && previous?.[input.key]) value = previous[input.key]!;
    if (!value && input.default) value = input.default;
    if (!value && input.required) throw new Error(`请填写「${input.label}」`);
    values[input.key] = value;
  }
  return values;
}

function mcpPayload(item: CatalogItem, values: Record<string, string>): McpServerInput {
  const mcp = item.mcp!;
  const map = (record?: Record<string, string>) => Object.fromEntries(Object.entries(record ?? {}).map(([key, value]) => [key, render(String(value), values)]));
  return mcp.transport === "http"
    ? { name: item.name, transport: "http", url: render(mcp.url!, values), headers: map(mcp.headers) }
    : { name: item.name, transport: "stdio", command: render(mcp.command!, values), args: (mcp.args ?? []).map((arg) => render(String(arg), values)), env: map(mcp.env) };
}

function mcpFingerprint(id: string): string {
  const server = getMcpServer(id);
  return server ? hashOf([server.transport, server.command, server.args, server.env, server.url, server.headers]) : "";
}

function toolFingerprint(id: string): string {
  const item = getResourceLibraryItemsByIds("tool", [id])[0];
  return item ? hashOf([item.content, item.command]) : "";
}

export interface CatalogInstallResult {
  kind: CatalogKind;
  targetId: string;
  action: "installed" | "updated";
  warnings: string[];
}

export async function installCatalogItem(input: { sourceId: string; itemId: string; inputs?: Record<string, string>; force?: boolean; groupId?: string | null }): Promise<CatalogInstallResult> {
  const source = readSources().find((entry) => entry.id === input.sourceId);
  if (!source || !source.enabled) throw new Error("没有这个订阅源，或者它已关闭");
  const loaded = await loadSource(source, false);
  const item = loaded.items.find((entry) => entry.id === input.itemId);
  if (!item) throw new Error("目录里没有这一项（可能已下架），请刷新");
  const installs = readInstalls();
  const key = recordKey(source.id, item.id);
  const previous = installs[key] && targetExists(installs[key]!) ? installs[key]! : null;
  // New installs default to ungrouped. Updates keep the user's category unless explicitly changed.
  const currentGroup = previous
    ? item.kind === "mcp" ? getMcpServer(previous.targetId)?.groupId : getResourceLibraryItemsByIds(item.kind, [previous.targetId])[0]?.groupId
    : null;
  const groupId = checkResourceGroupId(item.kind, input.groupId === undefined ? currentGroup : input.groupId);
  const values = resolveInputs(item, input.inputs, previous?.inputs);
  const warnings: string[] = [];
  let targetId: string;
  let hash = "";

  if (isStore(source) && item.kind === "skill") {
    if (!source.key) throw new Error("请先连接官网账号");
    if (!item.owned) throw new Error(`还没购买「${item.name}」`);
    const result = await installStoreSkill({
      base: source.url, token: source.key, sourceId: source.id, itemId: item.id, name: item.name, license: item.license,
      groupId,
    }).catch((err) => { forgetStoreTokenOn(err, source.id, source.key); throw err; });
    warnings.push(...result.warnings);
    targetId = result.targetId;
  } else if (item.kind === "skill") {
    const src = item.source!;
    const url = `https://github.com/${src.repo}/tree/${encodeURIComponent(src.ref || "HEAD")}/${src.path}`.replace(/\/$/, "");
    const result = await installGithubSkills({ url, paths: [src.path], groupId, autoGroup: false });
    warnings.push(...result.warnings);
    if (!result.installed && !result.updated) throw new Error(result.warnings.join("；") || "安装失败");
    const entry = path.resolve(githubSkillEntryPath(src.repo, src.path));
    const library = listResourceLibraryItems("skill").find((skill) => skill.sourcePath && path.resolve(skill.sourcePath) === entry);
    if (!library) throw new Error("Skill 已下载，但没有登记进技能库");
    targetId = library.id;
  } else if (item.kind === "mcp") {
    const payload = { ...mcpPayload(item, values), groupId };
    if (previous) {
      if (!input.force && mcpFingerprint(previous.targetId) !== previous.hash) throw new CatalogConflictError(`「${item.name}」装好后被你改过，更新会覆盖你的修改`);
      targetId = updateMcpServer(previous.targetId, { ...payload, name: undefined }).id;
    } else {
      targetId = createMcpServer(payload).id;
    }
    hash = mcpFingerprint(targetId);
  } else {
    const tool = item.tool!;
    if (previous) {
      if (!input.force && toolFingerprint(previous.targetId) !== previous.hash) throw new CatalogConflictError(`「${item.name}」装好后被你改过，更新会覆盖你的修改`);
      const current = getResourceLibraryItemsByIds("tool", [previous.targetId])[0]!;
      targetId = updateResourceLibraryItem("tool", previous.targetId, { title: current.title, content: tool.content, command: tool.command ?? null, tags: current.tags, groupId }).id;
    } else {
      targetId = createResourceLibraryItem("tool", { title: item.name, content: tool.content, command: tool.command ?? null, tags: item.tags ?? [], groupId }).id;
    }
    hash = toolFingerprint(targetId);
  }

  if (item.kind === "skill") moveResourcesToGroup("skill", [targetId], groupId);
  const next = readInstalls();
  next[key] = { kind: item.kind, version: item.version, targetId, hash, inputs: values, installedAt: new Date().toISOString() };
  writeJsonAtomic(installsPath(), next);
  return { kind: item.kind, targetId, action: previous ? "updated" : "installed", warnings };
}

function webUrl(value: unknown): string | null {
  return typeof value === "string" && /^https?:\/\//i.test(value) ? value : null;
}

function sourceView(source: CatalogSource): CatalogSourceView {
  let homeUrl: string | null = null;
  if (isStore(source)) { try { homeUrl = new URL(source.url).origin; } catch { /* 地址不对，保存时已经拦过 */ } }
  return {
    id: source.id, type: source.type ?? "catalog", name: source.name, url: source.url, hasKey: Boolean(source.key), builtin: source.builtin, enabled: source.enabled,
    catalogName: null, description: null, updatedAt: null, bundled: false, error: null,
    account: isStore(source) && source.key && source.account ? { email: source.account.email, displayName: source.account.displayName } : null,
    homeUrl,
  };
}

export function listCatalogSources(): CatalogSourceView[] {
  return readSources().map(sourceView);
}

/** 商店源的完整信息（含令牌），只给服务端内部用。 */
export function getStoreSource(id: string): CatalogSource {
  const source = readSources().find((entry) => entry.id === id);
  if (!source || !isStore(source)) throw new Error("没有这个商店订阅源");
  if (!source.enabled) throw new Error("这个商店订阅源已关闭");
  return source;
}

/** 保存或清除商店源的登录令牌和账号。 */
export function setStoreCredentials(id: string, key: string | null, account: StoreAccount | null) {
  writeSources(readSources().map((source) => source.id === id ? { ...source, key, account } : source));
  cache.delete(id);
}

/** 商店说令牌无效（比如在官网取消了这台设备的授权）：清掉本机令牌，页面回到「连接官网账号」。期间重新连过的不动。 */
export function forgetStoreToken(id: string, key: string | null | undefined) {
  if (key && readSources().find((source) => source.id === id)?.key === key) setStoreCredentials(id, null, null);
}

export function forgetStoreTokenOn(err: unknown, id: string, key: string | null | undefined) {
  if (err instanceof StoreApiError && err.status === 401) forgetStoreToken(id, key);
}

export function saveCatalogSource(input: { name?: string; url?: string; key?: string | null; enabled?: boolean; type?: CatalogSourceType }, id?: string): CatalogSourceView {
  const sources = readSources();
  const current = id ? sources.find((source) => source.id === id) : undefined;
  if (id && !current) throw new Error("没有这个订阅源");
  let next: CatalogSource;
  if (current?.builtin) {
    next = { ...current, enabled: input.enabled ?? current.enabled };
  } else {
    const url = (input.url ?? current?.url ?? "").trim();
    const type: CatalogSourceType = current ? current.type ?? "catalog" : input.type === "store" ? "store" : "catalog";
    if (!url) throw new Error(type === "store" ? "请填写商店地址" : "请填写订阅地址");
    if (type === "store" && !/^https?:\/\//i.test(url)) throw new Error("商店地址要以 http:// 或 https:// 开头");
    if (!/^https?:\/\//i.test(url) && !isLocalPath(url)) throw new Error("订阅地址要以 http:// 或 https:// 开头，或者是本机文件路径");
    const name = (input.name ?? current?.name ?? "").trim() || new URL(/^https?:/i.test(url) ? url : "file:///x").hostname || "本机目录";
    // key：undefined 表示不改，空字符串表示清除。
    const key = input.key === undefined ? current?.key ?? null : input.key?.trim() || null;
    const sourceId = current?.id ?? `source-${nanoid(8)}`;
    const enabled = input.enabled ?? current?.enabled ?? true;
    // 商店的令牌只能通过「连接官网账号」拿到；换了地址，原来的令牌对新地址没用。
    next = type === "store"
      ? { id: sourceId, type, name, url, key: current?.url === url ? current.key : null, account: current?.url === url ? current.account ?? null : null, builtin: false, enabled }
      : { id: sourceId, name, url, key, builtin: false, enabled };
  }
  writeSources(current ? sources.map((source) => source.id === next.id ? next : source) : [...sources, next]);
  cache.delete(next.id);
  return listCatalogSources().find((source) => source.id === next.id)!;
}

export function deleteCatalogSource(id: string): boolean {
  const sources = readSources();
  const target = sources.find((source) => source.id === id);
  if (!target) return false;
  if (target.builtin) throw new Error("内置的订阅源不能删除，可以关闭");
  writeSources(sources.filter((source) => source.id !== id));
  cache.delete(id);
  return true;
}
