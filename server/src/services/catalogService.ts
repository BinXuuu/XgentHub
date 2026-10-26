import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import { ProxyAgent } from "undici";
import { config } from "../config.ts";
import { readJsonFile, writeJsonAtomic } from "./jsonStore.ts";
import { githubSkillEntryPath, installGithubSkills } from "./githubSkillService.ts";
import { createMcpServer, getMcpServer, updateMcpServer, type McpServerInput } from "./mcpServerService.ts";
import {
  createResourceLibraryItem,
  getResourceLibraryItemsByIds,
  listResourceLibraryItems,
  listSkillGroups,
  saveSkillGroup,
  updateResourceLibraryItem,
} from "./resourceLibraryService.ts";

// 推荐目录：从订阅源（一个 JSON 文件）读出整理好的 Skill / MCP / 工具，一键装进 Xgent。
// 内置的官方源默认读 GitHub 上的 catalog/catalog.json，读不到时用随程序附带的同一个文件；
// 用户还可以加别的源（以后的会员目录就是一个带访问密钥的源）。装过什么、装的哪个版本记在 catalog-installs.json。

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
  source?: { type: "github"; repo: string; ref?: string; path: string };
  mcp?: { transport: "stdio" | "http"; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> };
  tool?: { content: string; command?: string };
  inputs?: CatalogInput[];
}

interface CatalogFile {
  version: number;
  name?: string;
  description?: string;
  updatedAt?: string;
  groups?: Array<{ id: string; name: string; description?: string }>;
  items?: CatalogItem[];
}

export interface CatalogSource {
  id: string;
  name: string;
  url: string;
  /** 访问密钥（会员目录用），发请求时放在 Authorization: Bearer 里。 */
  key: string | null;
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
}

export interface CatalogView {
  sources: CatalogSourceView[];
  groups: Array<{ sourceId: string; id: string; name: string; description: string }>;
  items: CatalogItemView[];
  warnings: string[];
}

export class CatalogConflictError extends Error {
  code = "modified";
}

const BUILTIN_ID = "official";
const DEFAULT_URL = "https://raw.githubusercontent.com/BinXuuu/XgentHub/main/catalog/catalog.json";
const BUNDLED_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../catalog/catalog.json");
const CACHE_MS = 10 * 60 * 1000;
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
const proxyDispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

function sourcesPath() { return path.join(config.dataDir, "catalog-sources.json"); }
function installsPath() { return path.join(config.dataDir, "catalog-installs.json"); }

function builtinSource(): CatalogSource {
  return { id: BUILTIN_ID, name: "Xgent 官方推荐", url: process.env.XGENT_CATALOG_URL?.trim() || DEFAULT_URL, key: null, builtin: true, enabled: true };
}

function readSources(): CatalogSource[] {
  const saved = readJsonFile<CatalogSource[]>(sourcesPath(), []).filter((source) => source && source.id !== BUILTIN_ID);
  const builtinState = readJsonFile<CatalogSource[]>(sourcesPath(), []).find((source) => source?.id === BUILTIN_ID);
  return [{ ...builtinSource(), enabled: builtinState?.enabled ?? true }, ...saved];
}

function writeSources(sources: CatalogSource[]) {
  // 内置源只保存开关状态，地址始终用程序里的默认值（或环境变量）。
  writeJsonAtomic(sourcesPath(), sources.map((source) => source.builtin ? { id: source.id, enabled: source.enabled } : source));
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
export function parseCatalog(text: string, label: string): { file: CatalogFile; items: CatalogItem[]; warnings: string[] } {
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
      if (item.kind === "skill") {
        const src = item.source;
        if (src?.type !== "github" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(src.repo ?? "") || typeof src.path !== "string") return "skill 需要 source: { type: github, repo, path }";
        if (src.path.split("/").some((part) => part === ".." || part === ".")) return "source.path 不合法";
      } else if (item.kind === "mcp") {
        const mcp = item.mcp;
        if (!mcp || (mcp.transport === "stdio" ? !mcp.command : mcp.transport === "http" ? !mcp.url : true)) return "mcp 需要 transport 和 command / url";
      } else if (item.kind === "tool") {
        if (!item.tool || typeof item.tool.content !== "string" || !item.tool.content.trim()) return "tool 需要 content";
      } else return `不认识的类型 ${String(item.kind)}`;
      if (item.inputs && (!Array.isArray(item.inputs) || item.inputs.some((input) => !input || !/^[A-Za-z0-9_]+$/.test(input.key ?? "") || !input.label))) return "inputs 格式不对";
      return null;
    })();
    if (problem) { warnings.push(`${label} · ${name}：${problem}，已跳过`); continue; }
    seen.add(item.id);
    items.push({ ...item, summary: typeof item.summary === "string" ? item.summary : "", tags: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === "string") : [] });
  }
  return { file, items, warnings };
}

const cache = new Map<string, { at: number; url: string; key: string | null; result: { file: CatalogFile; items: CatalogItem[]; warnings: string[]; bundled: boolean } }>();

async function loadSource(source: CatalogSource, force: boolean) {
  const hit = cache.get(source.id);
  if (!force && hit && hit.url === source.url && hit.key === source.key && Date.now() - hit.at < CACHE_MS) return hit.result;
  let result: { file: CatalogFile; items: CatalogItem[]; warnings: string[]; bundled: boolean };
  try {
    result = { ...parseCatalog(await fetchCatalogText(source), source.name), bundled: false };
  } catch (err) {
    // 官方源连不上时退回随程序附带的目录，离线也能装（Skill 本身仍要能访问 GitHub）。
    if (!source.builtin || !fs.existsSync(BUNDLED_PATH)) throw err;
    result = { ...parseCatalog(fs.readFileSync(BUNDLED_PATH, "utf8"), source.name), bundled: true };
    result.warnings.unshift(`${source.name}：${(err as Error).message}，暂时显示随程序附带的目录`);
  }
  cache.set(source.id, { at: Date.now(), url: source.url, key: source.key, result });
  return result;
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
    const base: CatalogSourceView = {
      id: source.id, name: source.name, url: source.url, hasKey: Boolean(source.key), builtin: source.builtin, enabled: source.enabled,
      catalogName: null, description: null, updatedAt: null, bundled: false, error: null,
    };
    if (!source.enabled) { view.sources.push(base); continue; }
    try {
      const loaded = await loadSource(source, force);
      view.sources.push({ ...base, catalogName: loaded.file.name ?? null, description: loaded.file.description ?? null, updatedAt: loaded.file.updatedAt ?? null, bundled: loaded.bundled });
      view.warnings.push(...loaded.warnings);
      for (const group of loaded.file.groups ?? []) {
        if (group && typeof group.id === "string" && typeof group.name === "string") view.groups.push({ sourceId: source.id, id: group.id, name: group.name, description: group.description ?? "" });
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

function skillGroupFor(sourceId: string, groupId: string | undefined, groupName: string | undefined): string | null {
  if (!groupId || !groupName) return null;
  const source = `catalog:${sourceId}/${groupId}`;
  const groups = listSkillGroups();
  const existing = groups.find((group) => group.source === source);
  if (existing) return existing.id;
  let name = groupName;
  for (let n = 2; groups.some((group) => group.name.toLowerCase() === name.toLowerCase()); n++) name = `${groupName} (${n})`;
  return saveSkillGroup({ name, source, description: `从推荐目录安装。` }).id;
}

export interface CatalogInstallResult {
  kind: CatalogKind;
  targetId: string;
  action: "installed" | "updated";
  warnings: string[];
}

export async function installCatalogItem(input: { sourceId: string; itemId: string; inputs?: Record<string, string>; force?: boolean }): Promise<CatalogInstallResult> {
  const source = readSources().find((entry) => entry.id === input.sourceId);
  if (!source || !source.enabled) throw new Error("没有这个订阅源，或者它已关闭");
  const loaded = await loadSource(source, false);
  const item = loaded.items.find((entry) => entry.id === input.itemId);
  if (!item) throw new Error("目录里没有这一项（可能已下架），请刷新");
  const installs = readInstalls();
  const key = recordKey(source.id, item.id);
  const previous = installs[key] && targetExists(installs[key]!) ? installs[key]! : null;
  const values = resolveInputs(item, input.inputs, previous?.inputs);
  const warnings: string[] = [];
  let targetId: string;
  let hash = "";

  if (item.kind === "skill") {
    const src = item.source!;
    const groupName = loaded.file.groups?.find((group) => group.id === item.group)?.name;
    const groupId = skillGroupFor(source.id, item.group, groupName);
    const url = `https://github.com/${src.repo}/tree/${encodeURIComponent(src.ref || "HEAD")}/${src.path}`.replace(/\/$/, "");
    const result = await installGithubSkills({ url, paths: [src.path], groupId });
    warnings.push(...result.warnings);
    if (!result.installed && !result.updated) throw new Error(result.warnings.join("；") || "安装失败");
    const entry = path.resolve(githubSkillEntryPath(src.repo, src.path));
    const library = listResourceLibraryItems("skill").find((skill) => skill.sourcePath && path.resolve(skill.sourcePath) === entry);
    if (!library) throw new Error("Skill 已下载，但没有登记进技能库");
    targetId = library.id;
  } else if (item.kind === "mcp") {
    const payload = mcpPayload(item, values);
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
      targetId = updateResourceLibraryItem("tool", previous.targetId, { title: current.title, content: tool.content, command: tool.command ?? null, tags: current.tags }).id;
    } else {
      targetId = createResourceLibraryItem("tool", { title: item.name, content: tool.content, command: tool.command ?? null, tags: item.tags ?? [] }).id;
    }
    hash = toolFingerprint(targetId);
  }

  const next = readInstalls();
  next[key] = { kind: item.kind, version: item.version, targetId, hash, inputs: values, installedAt: new Date().toISOString() };
  writeJsonAtomic(installsPath(), next);
  return { kind: item.kind, targetId, action: previous ? "updated" : "installed", warnings };
}

export function listCatalogSources(): CatalogSourceView[] {
  return readSources().map((source) => ({
    id: source.id, name: source.name, url: source.url, hasKey: Boolean(source.key), builtin: source.builtin, enabled: source.enabled,
    catalogName: null, description: null, updatedAt: null, bundled: false, error: null,
  }));
}

export function saveCatalogSource(input: { name?: string; url?: string; key?: string | null; enabled?: boolean }, id?: string): CatalogSourceView {
  const sources = readSources();
  const current = id ? sources.find((source) => source.id === id) : undefined;
  if (id && !current) throw new Error("没有这个订阅源");
  let next: CatalogSource;
  if (current?.builtin) {
    next = { ...current, enabled: input.enabled ?? current.enabled };
  } else {
    const url = (input.url ?? current?.url ?? "").trim();
    if (!url) throw new Error("请填写订阅地址");
    if (!/^https?:\/\//i.test(url) && !isLocalPath(url)) throw new Error("订阅地址要以 http:// 或 https:// 开头，或者是本机文件路径");
    const name = (input.name ?? current?.name ?? "").trim() || new URL(/^https?:/i.test(url) ? url : "file:///x").hostname || "本机目录";
    // key：undefined 表示不改，空字符串表示清除。
    const key = input.key === undefined ? current?.key ?? null : input.key?.trim() || null;
    next = { id: current?.id ?? `source-${nanoid(8)}`, name, url, key, builtin: false, enabled: input.enabled ?? current?.enabled ?? true };
  }
  writeSources(current ? sources.map((source) => source.id === next.id ? next : source) : [...sources, next]);
  cache.delete(next.id);
  return listCatalogSources().find((source) => source.id === next.id)!;
}

export function deleteCatalogSource(id: string): boolean {
  const sources = readSources();
  const target = sources.find((source) => source.id === id);
  if (!target) return false;
  if (target.builtin) throw new Error("官方推荐源不能删除，可以关闭");
  writeSources(sources.filter((source) => source.id !== id));
  cache.delete(id);
  return true;
}
