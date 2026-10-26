import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { ProxyAgent } from "undici";
import { config } from "../config.ts";
import { createResourceLibraryItem, listResourceLibraryItems, listSkillGroups, saveSkillGroup } from "./resourceLibraryService.ts";

// 从 GitHub 链接安装 Skill：读仓库文件树找出所有 SKILL.md，下载整个 Skill 目录到数据目录，
// 再以「文件型 Skill」登记进技能库（跟导入本机已装插件一样只记 SKILL.md 入口）。只下载文件，不运行其中的脚本。
// 只用两次 GitHub API（解析提交、读文件树），文件本身走 raw.githubusercontent.com，不占 API 次数。

const API_BASE = (process.env.XGENT_GITHUB_API_BASE || "https://api.github.com").replace(/\/+$/, "");
const RAW_BASE = (process.env.XGENT_GITHUB_RAW_BASE || "https://raw.githubusercontent.com").replace(/\/+$/, "");
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
const proxyDispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

const MAX_SKILLS = 200;
const MAX_FILES_PER_SKILL = 300;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SKILL_BYTES = 50 * 1024 * 1024;
const SOURCE_FILE = "XGENT-SOURCE.json";

export interface GithubSkillCandidate {
  /** 仓库里 Skill 目录的路径，仓库根目录是 ""。 */
  path: string;
  name: string;
  description: string;
  files: number;
  bytes: number;
  license: string;
  /** true：开源许可；false：明确的专有 / 保留权利；null：没找到许可说明。 */
  openLicense: boolean | null;
  installed: boolean;
}

export interface GithubSkillPreview {
  repo: string;
  ref: string;
  commit: string;
  url: string;
  skills: GithubSkillCandidate[];
  warnings: string[];
}

export interface GithubSkillInstallResult {
  installed: number;
  updated: number;
  groupId: string | null;
  warnings: string[];
}

interface RepoTarget { owner: string; repo: string; ref: string | null; path: string }
interface TreeEntry { path: string; type: string; mode: string; size?: number }

/** 支持 https://github.com/o/r、…/tree/<分支>/<目录>、…/blob/<分支>/<目录>/SKILL.md，以及末尾的 .git。 */
export function parseGithubUrl(input: string): RepoTarget {
  const text = input.trim();
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new Error("请填写 GitHub 链接，例如 https://github.com/anthropics/skills");
  }
  if (!/^(www\.)?github\.com$/i.test(url.hostname)) throw new Error("目前只支持 github.com 上的公开仓库链接");
  const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts.length < 2) throw new Error("链接里缺少仓库名，例如 https://github.com/anthropics/skills");
  const [owner, rawRepo, kind, ref, ...rest] = parts;
  const repo = rawRepo!.replace(/\.git$/i, "");
  const valid = /^[A-Za-z0-9_.-]+$/;
  if (!valid.test(owner!) || !valid.test(repo)) throw new Error("仓库名不合法");
  if (!kind) return { owner: owner!, repo, ref: null, path: "" };
  if ((kind !== "tree" && kind !== "blob") || !ref) throw new Error("请使用仓库首页、目录（/tree/…）或 SKILL.md 文件（/blob/…）的链接");
  let target = rest.join("/").replace(/\/+$/, "");
  if (kind === "blob") target = path.posix.dirname(target).replace(/^\.$/, ""); // 指向文件时按它所在的目录找 Skill
  return { owner: owner!, repo, ref, path: target };
}

async function github(url: string, raw = false): Promise<Response> {
  const headers: Record<string, string> = { "User-Agent": "XgentHub-skills" };
  if (!raw) {
    headers.Accept = "application/vnd.github+json";
    const token = process.env.GITHUB_TOKEN?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  try {
    return await fetch(url, {
      headers,
      signal: AbortSignal.timeout(30_000),
      ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
    } as RequestInit);
  } catch (err) {
    const reason = (err as Error).name === "TimeoutError" ? "30 秒内没有响应" : (err as Error).message;
    throw new Error(`连不上 GitHub（${reason}）。国内网络可以在 .env 里设置 HTTPS_PROXY 走代理。`);
  }
}

async function githubJson<T>(url: string): Promise<T> {
  const res = await github(url);
  if (res.status === 404) throw new Error("没找到这个仓库或分支（私有仓库暂不支持）");
  if (res.status === 403 || res.status === 429) {
    throw new Error("GitHub 接口访问次数用完了（不登录每小时 60 次），请过一会儿再试，或在 .env 里设置 GITHUB_TOKEN");
  }
  if (!res.ok) throw new Error(`GitHub 返回 HTTP ${res.status}`);
  return (await res.json()) as T;
}

function rawUrl(target: RepoTarget, commit: string, filePath: string): string {
  return `${RAW_BASE}/${target.owner}/${target.repo}/${commit}/${filePath.split("/").map(encodeURIComponent).join("/")}`;
}

async function fetchRawText(target: RepoTarget, commit: string, filePath: string): Promise<string> {
  const res = await github(rawUrl(target, commit, filePath), true);
  if (!res.ok) throw new Error(`下载 ${filePath} 失败：HTTP ${res.status}`);
  return res.text();
}

/** 读 SKILL.md 开头 --- 之间的 name / description / license，支持引号和 > | 多行写法。 */
export function parseSkillFrontmatter(markdown: string): Record<string, string> {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  const result: Record<string, string> = {};
  if (!match) return result;
  const lines = match[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]!);
    if (!line) continue;
    let value = line[2]!.trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || !lines[i + 1]!.trim())) block.push(lines[++i]!.trim());
      value = (value.startsWith(">") ? block.join(" ") : block.join("\n")).trim();
    } else if (value.startsWith('"') && value.endsWith('"') && value.length > 1) {
      try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
    } else if (value.startsWith("'") && value.endsWith("'") && value.length > 1) {
      value = value.slice(1, -1).replace(/''/g, "'");
    }
    result[line[1]!] = value;
  }
  return result;
}

const OPEN_LICENSES: Array<[RegExp, string]> = [
  [/apache license|apache-2\.0/i, "Apache-2.0"],
  [/\bmit license\b|^mit$/i, "MIT"],
  [/gnu affero|agpl/i, "AGPL"],
  [/gnu lesser|lgpl/i, "LGPL"],
  [/gnu general public|\bgpl\b/i, "GPL"],
  [/mozilla public|mpl-2/i, "MPL-2.0"],
  [/\bbsd\b/i, "BSD"],
  [/\bisc license\b|^isc$/i, "ISC"],
  [/unlicense|public domain|cc0/i, "Public domain"],
  [/creative commons attribution|cc-by/i, "CC-BY"],
];

/** 按许可文本或 frontmatter 的 license 字段判断：开源 / 专有 / 不明。 */
export function classifyLicense(text: string): { license: string; openLicense: boolean | null } {
  const head = text.slice(0, 1500);
  for (const [pattern, name] of OPEN_LICENSES) if (pattern.test(head)) return { license: name, openLicense: true };
  if (/proprietary|all rights reserved|terms of service/i.test(head)) return { license: "专有许可", openLicense: false };
  return head.trim() ? { license: "自定义许可", openLicense: null } : { license: "未注明", openLicense: null };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  }));
  return results;
}

export function githubSkillsRoot(): string {
  return path.join(config.dataDir, "skills", "github");
}

function safeSegment(segment: string): string {
  const cleaned = segment.replace(/[<>:"|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "_");
  if (!cleaned || cleaned === "." || cleaned === "..") return "_";
  return cleaned;
}

function installDir(target: RepoTarget, skillPath: string): string {
  const segments = [target.owner, target.repo, ...(skillPath ? skillPath.split("/") : ["_root"])].map(safeSegment);
  return path.join(githubSkillsRoot(), ...segments);
}

/** 某个仓库目录安装后 SKILL.md 所在的位置（repo 写成 owner/name）。 */
export function githubSkillEntryPath(repo: string, skillPath: string): string {
  const [owner = "", name = ""] = repo.split("/");
  return path.join(installDir({ owner, repo: name, ref: null, path: "" }, skillPath), "SKILL.md");
}

function pathKey(value: string): string {
  return process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
}

interface RepoSnapshot { target: RepoTarget; ref: string; commit: string; skills: Map<string, TreeEntry[]>; warnings: string[] }

async function loadRepo(url: string): Promise<RepoSnapshot> {
  const target = parseGithubUrl(url);
  const ref = target.ref ?? "HEAD";
  const commit = (await githubJson<{ sha: string }>(`${API_BASE}/repos/${target.owner}/${target.repo}/commits/${encodeURIComponent(ref)}`)).sha;
  const tree = await githubJson<{ tree: TreeEntry[]; truncated?: boolean }>(`${API_BASE}/repos/${target.owner}/${target.repo}/git/trees/${commit}?recursive=1`);
  const warnings: string[] = [];
  if (tree.truncated) warnings.push("仓库文件太多，GitHub 只返回了一部分，可能有 Skill 没列出来；可以改用具体目录的链接。");
  const prefix = target.path ? `${target.path}/` : "";
  const blobs = tree.tree.filter((entry) => entry.type === "blob" && entry.mode !== "120000" && (!prefix || entry.path.startsWith(prefix)));
  const dirs = blobs.filter((entry) => path.posix.basename(entry.path) === "SKILL.md").map((entry) => path.posix.dirname(entry.path).replace(/^\.$/, ""));
  if (!dirs.length) throw new Error(target.path ? `目录 ${target.path} 里没有找到 SKILL.md` : "这个仓库里没有找到 SKILL.md，不是 Skill 仓库");
  if (dirs.length > MAX_SKILLS) warnings.push(`找到 ${dirs.length} 个 Skill，只列出前 ${MAX_SKILLS} 个；可以改用具体目录的链接。`);
  // 每个文件归到离它最近的那个 Skill 目录，嵌套的 Skill 不重复计入外层。
  const sorted = dirs.slice(0, MAX_SKILLS).sort((a, b) => b.length - a.length);
  const skills = new Map<string, TreeEntry[]>(sorted.map((dir) => [dir, []]));
  for (const entry of blobs) {
    const home = sorted.find((dir) => !dir || entry.path.startsWith(`${dir}/`));
    if (home !== undefined) skills.get(home)!.push(entry);
  }
  const symlinks = tree.tree.filter((entry) => entry.mode === "120000" && (!prefix || entry.path.startsWith(prefix))).length;
  if (symlinks) warnings.push(`跳过了 ${symlinks} 个符号链接`);
  return { target, ref, commit, skills, warnings };
}

async function readSkillMeta(snapshot: RepoSnapshot, dir: string, entries: TreeEntry[], licenseCache: Map<string, Promise<string>>) {
  const skillFile = dir ? `${dir}/SKILL.md` : "SKILL.md";
  const frontmatter = parseSkillFrontmatter(await fetchRawText(snapshot.target, snapshot.commit, skillFile));
  const licenseFile = entries.find((entry) => /^(LICENSE|LICENCE|COPYING)(\.[a-z]+)?$/i.test(path.posix.basename(entry.path)))?.path;
  let licenseText = "";
  if (licenseFile) licenseText = await fetchRawText(snapshot.target, snapshot.commit, licenseFile).catch(() => "");
  else if (!frontmatter.license) {
    // Skill 目录里没有许可文件时看仓库根目录的。
    if (!licenseCache.has("")) {
      licenseCache.set("", (async () => {
        for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt"]) {
          const text = await fetchRawText(snapshot.target, snapshot.commit, name).catch(() => "");
          if (text) return text;
        }
        return "";
      })());
    }
    licenseText = await licenseCache.get("")!;
  }
  const license = classifyLicense(licenseText || frontmatter.license || "");
  return {
    name: frontmatter.name?.trim() || path.posix.basename(dir) || snapshot.target.repo,
    description: frontmatter.description?.trim() || "",
    ...license,
  };
}

export async function previewGithubSkills(url: string): Promise<GithubSkillPreview> {
  const snapshot = await loadRepo(url);
  const installedKeys = new Set(listResourceLibraryItems("skill").filter((item) => item.sourcePath).map((item) => pathKey(item.sourcePath!)));
  const licenseCache = new Map<string, Promise<string>>();
  const dirs = [...snapshot.skills.keys()].sort();
  const skills = await mapLimit(dirs, 6, async (dir) => {
    const entries = snapshot.skills.get(dir)!;
    const meta = await readSkillMeta(snapshot, dir, entries, licenseCache);
    return {
      path: dir,
      ...meta,
      files: entries.length,
      bytes: entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0),
      installed: installedKeys.has(pathKey(path.join(installDir(snapshot.target, dir), "SKILL.md"))),
    } satisfies GithubSkillCandidate;
  });
  return {
    repo: `${snapshot.target.owner}/${snapshot.target.repo}`,
    ref: snapshot.target.ref ?? "默认分支",
    commit: snapshot.commit,
    url: `https://github.com/${snapshot.target.owner}/${snapshot.target.repo}`,
    skills,
    warnings: snapshot.warnings,
  };
}

async function downloadSkill(snapshot: RepoSnapshot, dir: string, entries: TreeEntry[], meta: { license: string }): Promise<string> {
  if (entries.length > MAX_FILES_PER_SKILL) throw new Error(`文件太多（${entries.length} 个，上限 ${MAX_FILES_PER_SKILL}）`);
  const total = entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  if (total > MAX_SKILL_BYTES) throw new Error(`太大（${Math.round(total / 1024 / 1024)} MB，上限 ${MAX_SKILL_BYTES / 1024 / 1024} MB）`);
  const dest = installDir(snapshot.target, dir);
  const temp = `${dest}.tmp-${nanoid(6)}`;
  fs.mkdirSync(temp, { recursive: true });
  try {
    await mapLimit(entries, 6, async (entry) => {
      if ((entry.size ?? 0) > MAX_FILE_BYTES) throw new Error(`${entry.path} 超过 ${MAX_FILE_BYTES / 1024 / 1024} MB`);
      const relative = dir ? entry.path.slice(dir.length + 1) : entry.path;
      const segments = relative.split("/");
      if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error(`文件路径不安全：${entry.path}`);
      const file = path.join(temp, ...segments.map(safeSegment));
      if (!file.startsWith(temp + path.sep)) throw new Error(`文件路径不安全：${entry.path}`);
      const res = await github(rawUrl(snapshot.target, snapshot.commit, entry.path), true);
      if (!res.ok) throw new Error(`下载 ${entry.path} 失败：HTTP ${res.status}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    });
    fs.writeFileSync(path.join(temp, SOURCE_FILE), `${JSON.stringify({
      repo: `${snapshot.target.owner}/${snapshot.target.repo}`,
      ref: snapshot.ref,
      commit: snapshot.commit,
      path: dir,
      license: meta.license,
      url: `https://github.com/${snapshot.target.owner}/${snapshot.target.repo}/tree/${snapshot.commit}/${dir}`,
      installedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    // 先下载到临时目录，全部成功才替换旧版本，下载到一半失败不会留下半个 Skill。
    const old = `${dest}.old-${nanoid(6)}`;
    if (fs.existsSync(dest)) fs.renameSync(dest, old);
    fs.renameSync(temp, dest);
    fs.rmSync(old, { recursive: true, force: true });
    return path.join(dest, "SKILL.md");
  } catch (err) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw err;
  }
}

export async function installGithubSkills(input: { url: string; paths: string[]; groupId?: string | null }): Promise<GithubSkillInstallResult> {
  if (!Array.isArray(input.paths) || !input.paths.length) throw new Error("请至少选择一个 Skill");
  const snapshot = await loadRepo(input.url);
  const result: GithubSkillInstallResult = { installed: 0, updated: 0, groupId: null, warnings: [...snapshot.warnings] };
  const repoName = `${snapshot.target.owner}/${snapshot.target.repo}`;
  const source = `github:${repoName}`;
  let groupId = input.groupId ?? null;
  if (groupId && !listSkillGroups().some((group) => group.id === groupId)) throw new Error(`未知技能组: ${groupId}`);
  const existing = new Map(listResourceLibraryItems("skill").filter((item) => item.sourcePath).map((item) => [pathKey(item.sourcePath!), item]));
  const licenseCache = new Map<string, Promise<string>>();
  for (const dir of input.paths) {
    const entries = snapshot.skills.get(dir);
    if (!entries) {
      result.warnings.push(`${dir || "仓库根目录"}：这个版本里没有找到`);
      continue;
    }
    try {
      const meta = await readSkillMeta(snapshot, dir, entries, licenseCache);
      const sourcePath = await downloadSkill(snapshot, dir, entries, meta);
      if (existing.has(pathKey(sourcePath))) {
        result.updated++; // 文件已换成新版本；技能库里的名称、说明和归组保留用户的编辑。
        continue;
      }
      if (!groupId) {
        const groups = listSkillGroups();
        let group = groups.find((entry) => entry.source === source);
        if (!group) {
          let name = repoName;
          for (let n = 2; groups.some((entry) => entry.name.toLowerCase() === name.toLowerCase()); n++) name = `${repoName} (${n})`;
          group = saveSkillGroup({ name, source, description: `从 GitHub 安装：https://github.com/${repoName}。只下载了文件，运行依赖和外部连接器需另行配置。` });
        }
        groupId = group.id;
      }
      const item = createResourceLibraryItem("skill", {
        title: meta.name,
        content: meta.description || `来自 ${repoName} 的 Skill，使用前先读取 SKILL.md。`,
        tags: ["GitHub", repoName, meta.license],
        groupId,
        sourcePath,
      });
      existing.set(pathKey(sourcePath), item);
      result.installed++;
      if (meta.openLicense === false) result.warnings.push(`${meta.name} 是专有许可，只能按其条款使用，不要转发或商用`);
    } catch (err) {
      result.warnings.push(`${dir || "仓库根目录"}：${(err as Error).message}`);
    }
  }
  result.groupId = groupId;
  return result;
}

/** 删除技能库条目时，顺带删掉由「从 GitHub 安装」下载到数据目录里的文件；其它来源的文件不动。 */
export function removeGithubSkillFiles(sourcePath: string | null | undefined): boolean {
  if (!sourcePath) return false;
  const root = githubSkillsRoot();
  const dir = path.dirname(path.resolve(sourcePath));
  const relative = path.relative(root, dir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  if (!fs.existsSync(path.join(dir, SOURCE_FILE))) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
