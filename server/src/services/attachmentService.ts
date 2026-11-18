import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { config } from "../config.ts";

const ATTACHMENTS_ROOT = path.join(config.dataDir, "attachments");

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[\\/:*?"<>|]/g, "_");
  return base || "file";
}

/**
 * 把前端传来的 base64 图片存到本机磁盘，返回绝对路径（供 adapter 的 -i/--image 使用）。
 * 上传发生在"组装消息"阶段（新建任务时任务还不存在、或还没发送），所以不按 taskId 归类，
 * 用一个统一的 pending 目录即可——文件一旦被某条消息引用，路径就写进那条消息里，不依赖目录结构。
 */
export function saveAttachment(filename: string, dataBase64: string): string {
  const dir = path.join(ATTACHMENTS_ROOT, "pending");
  fs.mkdirSync(dir, { recursive: true });
  const finalName = `${nanoid(8)}-${sanitizeFilename(filename)}`;
  const filePath = path.join(dir, finalName);
  const base64Payload = dataBase64.includes(",") ? dataBase64.slice(dataBase64.indexOf(",") + 1) : dataBase64;
  fs.writeFileSync(filePath, Buffer.from(base64Payload, "base64"));
  return filePath;
}

/** 路径确实在附件目录里面（按目录层级判断，不是比较字符串开头：旁边的 attachments-old 之类不算）。 */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** 文件存在时再按真实路径核一遍，防止通过目录联接 / 符号链接指到附件目录外面。 */
export function isAttachmentPath(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  if (!isInside(ATTACHMENTS_ROOT, resolved)) return false;
  try {
    return isInside(fs.realpathSync.native(ATTACHMENTS_ROOT), fs.realpathSync.native(resolved));
  } catch {
    return true; // 文件或附件目录还不存在：上面的层级判断已经够了
  }
}

export function getAttachment(filePath: string): { path: string; contentType: string } {
  const resolved = path.resolve(filePath);
  if (!isAttachmentPath(resolved)) throw new Error("附件路径不在允许目录内");
  if (!fs.existsSync(resolved)) throw new Error("附件不存在");
  const ext = path.extname(resolved).toLowerCase();
  const contentType =
    ext === ".png"
      ? "image/png"
      : ext === ".jpg" || ext === ".jpeg"
        ? "image/jpeg"
        : ext === ".gif"
          ? "image/gif"
          : ext === ".webp"
            ? "image/webp"
            : "application/octet-stream";
  return { path: resolved, contentType };
}

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" };

function pathKey(value: string): string {
  const key = value.replace(/\\/g, "/");
  return process.platform === "win32" ? key.toLowerCase() : key;
}

function decodeLoose(text: string): string {
  try { return decodeURIComponent(text); } catch { return text; }
}

/** text 里完整地写了这个路径（后面紧跟的不是文件名里的字符，免得 a.jpg 借 a.jpg.png 的名义被放行）。 */
function mentions(text: string, key: string): boolean {
  for (let at = text.indexOf(key); at !== -1; at = text.indexOf(key, at + 1)) {
    if (!/[\w.\-/]/.test(text[at + key.length] ?? "")) return true;
  }
  return false;
}

/**
 * Agent 在回复里提到的本机图片（工作区里生成的、Agent 自己目录里的），页面要显示时走这里。
 * 只给图片类型，而且路径确实写在这个任务的消息里（附件目录里的照旧可以），不能拿来读任意文件。
 */
export function getMentionedImage(filePath: string, texts: string[]): { path: string; contentType: string } {
  const resolved = path.resolve(filePath);
  const contentType = IMAGE_TYPES[path.extname(resolved).toLowerCase()];
  if (!contentType) throw new Error("只能显示图片");
  if (!isAttachmentPath(resolved)) {
    const key = pathKey(resolved);
    if (!texts.some((text) => mentions(pathKey(decodeLoose(text)), key))) throw new Error("消息里没有提到这张图片");
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error("图片不存在");
  return { path: resolved, contentType };
}

/**
 * 删除任务时，把还躺在 pending 目录、只被这个任务的排队消息引用过的图片一起清掉。
 * 只接受 ATTACHMENTS_ROOT 下的路径，避免误删任务/agent 实际产出的工作区文件。
 */
export function deleteAttachmentFile(filePath: string): void {
  const resolved = path.resolve(filePath);
  if (!isAttachmentPath(resolved)) return;
  try {
    fs.unlinkSync(resolved);
  } catch {
    // 文件已经不在了就算了
  }
}
