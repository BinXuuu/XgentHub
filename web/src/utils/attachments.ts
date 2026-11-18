import type { ClipboardEvent, DragEvent } from "react";
import { api } from "../api/client";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

/** 上传一批图片文件，返回本机绝对路径列表；文件选择框和剪贴板粘贴共用这一份逻辑。 */
export async function uploadImageFiles(files: File[]): Promise<string[]> {
  const paths: string[] = [];
  for (const file of files) {
    const dataBase64 = await fileToBase64(file);
    const res = await api.uploadAttachment(file.name || "pasted-image.png", dataBase64);
    paths.push(res.path);
  }
  return paths;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** 这个地址是不是一张图片：Xgent 自己显示图片用的接口（对话里 Agent 给的图），或者以图片扩展名结尾的网址 */
function imageUrlOf(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw, window.location.href);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  if (url.origin === window.location.origin && /^\/api\/(tasks|chats)\/[^/]+\/image$|^\/api\/attachments\/file$/.test(url.pathname)) {
    return url.searchParams.get("path") ? url : null;
  }
  return IMAGE_EXT.test(url.pathname) ? url : null;
}

/**
 * 粘贴 / 拖进来的是图片地址而不是图片本身：在对话里右键 Agent 给的图片选了「复制链接地址」、选中图片按 Ctrl+C、
 * 或者把对话里的图片拖进输入框。整段内容只有图片地址时才算（夹着别的文字就照常当文字）。
 */
function extractImageUrls(data: DataTransfer): URL[] {
  const uriList = data
    .getData("text/uri-list")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"));
  const text = (data.getData("text/plain") || uriList.join("\n")).trim();
  const html = data.getData("text/html");
  const fromHtml = [...html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!.replace(/&amp;/g, "&"));
  const tokens = text ? text.split(/\s+/) : [];
  const fromText = tokens.map(imageUrlOf);
  if (tokens.length && fromText.every(Boolean)) return fromText as URL[];
  // 选中图片复制 / 拖图片：纯文本部分是空的（或者就是图片地址），图片在 HTML 里
  if (!text || tokens.every((t) => fromHtml.includes(t))) {
    return fromHtml.map(imageUrlOf).filter((u): u is URL => Boolean(u));
  }
  return [];
}

async function fetchImageFile(url: URL): Promise<File> {
  const res = await fetch(url.href, { credentials: url.origin === window.location.origin ? "include" : "omit" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  if (!blob.type.startsWith("image/")) throw new Error("不是图片");
  const name = (url.searchParams.get("path") ?? url.pathname).split(/[\/]/).pop() || "pasted-image.png";
  return new File([blob], name, { type: blob.type });
}

/** 截图、复制的图片、从文件夹拖进来的图片文件 */
function extractImageFiles(data: DataTransfer): File[] {
  const files: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}

/**
 * 粘贴和拖放共用：图片文件、图片地址（取回图片）都变成图片附件交给 onFiles 上传，返回 true 表示接手了
 * （调用方要 preventDefault）；其他内容返回 false，照常当文字。图片地址取不回来时把原来的文字插进去。
 */
function takeImages(data: DataTransfer, textarea: HTMLTextAreaElement, onFiles: (files: File[]) => void): boolean {
  const files = extractImageFiles(data);
  if (files.length > 0) {
    onFiles(files);
    return true;
  }
  const urls = extractImageUrls(data);
  if (!urls.length) return false;
  const text = data.getData("text/plain") || urls.map((u) => u.href).join(" ");
  void Promise.all(urls.map(fetchImageFile)).then(onFiles, () => {
    textarea.focus();
    // 走浏览器自己的插入，React 的 onChange 照常触发，还能撤销
    if (!document.execCommand("insertText", false, text)) textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, "end");
  });
  return true;
}

/** 输入框的粘贴：截图、复制的图片、图片地址都变成图片附件；其他内容照常粘贴。 */
export function handleImagePaste(e: ClipboardEvent<HTMLTextAreaElement>, onFiles: (files: File[]) => void): void {
  if (takeImages(e.clipboardData, e.currentTarget, onFiles)) e.preventDefault();
}

/** 输入框的拖放：从文件夹拖进来的图片、从对话里拖过来的图片都变成图片附件；拖文字照常插入。 */
export function handleImageDrop(e: DragEvent<HTMLTextAreaElement>, onFiles: (files: File[]) => void): void {
  if (takeImages(e.dataTransfer, e.currentTarget, onFiles)) e.preventDefault();
}
