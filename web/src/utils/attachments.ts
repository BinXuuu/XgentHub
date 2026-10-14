import type { ClipboardEvent } from "react";
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

/** 从粘贴事件里挑出图片文件（截图/复制的图片走这里，不是文本粘贴）。 */
export function extractImageFiles(e: ClipboardEvent): File[] {
  const files: File[] = [];
  for (const item of Array.from(e.clipboardData.items)) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}
