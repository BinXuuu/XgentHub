import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

// 只解压、不执行的小 zip 解压器（商店下载的 Skill 包用），不引入第三方依赖。
// 只认普通文件和目录：拒绝加密、zip64、符号链接、绝对路径和 ..，并限制文件数和解压后的大小，防止 zip 炸弹。

export interface ZipLimits {
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 500, maxFileBytes: 20 * 1024 * 1024, maxTotalBytes: 100 * 1024 * 1024 };

interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
  isDir: boolean;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function fail(message: string): never {
  throw new Error(`压缩包不安全或已损坏：${message}`);
}

/** 校验条目路径：只允许相对路径，统一成 / 分隔，返回各级目录名。 */
export function safeZipPath(name: string): string[] {
  if (name.includes("\\")) fail(`路径里有反斜杠：${name}`);
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) fail(`绝对路径：${name}`);
  const parts = name.replace(/\/$/, "").split("/");
  for (const part of parts) {
    if (!part) fail(`路径里有空的目录名：${name}`);
    if (part === "." || part === "..") fail(`路径越界：${name}`);
    if (/[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part)) fail(`文件名不合法：${name}`);
  }
  return parts;
}

function readEntries(buf: Buffer, limits: ZipLimits): ZipEntry[] {
  // 从尾部往前找「中央目录结束」记录（后面可能跟最多 64KB 注释）。
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) fail("不是 zip 文件");
  const count = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralOffset === 0xffffffff) fail("不支持 zip64");
  if (count > limits.maxEntries) fail(`文件太多（${count} 个，上限 ${limits.maxEntries}）`);
  if (centralOffset + centralSize > eocd) fail("目录区越界");
  const entries: ZipEntry[] = [];
  let p = centralOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) fail("目录区损坏");
    const madeBy = buf.readUInt16LE(p + 4) >> 8;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttr = buf.readUInt32LE(p + 38);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x1) fail(`有加密文件：${name}`);
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) fail("不支持 zip64");
    // Unix 打包时高 16 位是文件类型，0o120000 是符号链接。
    const unixType = (externalAttr >>> 16) & 0o170000;
    if (madeBy === 3 && unixType === 0o120000) fail(`有符号链接：${name}`);
    const isDir = name.endsWith("/");
    if (!isDir && method !== 0 && method !== 8) fail(`不支持的压缩方式 ${method}：${name}`);
    if (size > limits.maxFileBytes) fail(`${name} 太大（上限 ${limits.maxFileBytes / 1024 / 1024} MB）`);
    entries.push({ name, method, crc, compressedSize, size, offset, isDir });
  }
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total > limits.maxTotalBytes) fail(`解压后太大（上限 ${limits.maxTotalBytes / 1024 / 1024} MB）`);
  return entries;
}

function readData(buf: Buffer, entry: ZipEntry, limits: ZipLimits): Buffer {
  const p = entry.offset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOCAL_SIG) fail(`文件头损坏：${entry.name}`);
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const end = start + entry.compressedSize;
  if (end > buf.length) fail(`数据越界：${entry.name}`);
  const raw = buf.subarray(start, end);
  let data: Buffer;
  if (entry.method === 0) data = Buffer.from(raw);
  else {
    try {
      // 目录里写的大小可能是假的，解压时按上限截断，超了直接报错。
      data = zlib.inflateRawSync(raw, { maxOutputLength: Math.min(limits.maxFileBytes, entry.size) + 1 });
    } catch (err) {
      fail(`${entry.name} 解压失败（${(err as Error).message}）`);
    }
  }
  if (data.length !== entry.size) fail(`${entry.name} 大小不符`);
  if ((zlib.crc32(data) >>> 0) !== entry.crc) fail(`${entry.name} 校验和不符`);
  return data;
}

/** 把 zip 解压到 destDir（必须不存在或为空），返回解压出的文件相对路径（/ 分隔）。 */
export function extractZip(buf: Buffer, destDir: string, limits: ZipLimits = DEFAULT_ZIP_LIMITS): string[] {
  const entries = readEntries(buf, limits);
  const root = path.resolve(destDir);
  fs.mkdirSync(root, { recursive: true });
  const files: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const parts = safeZipPath(entry.name);
    const target = path.join(root, ...parts);
    if (!target.startsWith(root + path.sep)) fail(`路径越界：${entry.name}`);
    const key = process.platform === "win32" ? target.toLowerCase() : target;
    if (seen.has(key)) fail(`文件重复：${entry.name}`);
    seen.add(key);
    if (entry.isDir) { fs.mkdirSync(target, { recursive: true }); continue; }
    const data = readData(buf, entry, limits);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    files.push(parts.join("/"));
  }
  return files;
}
