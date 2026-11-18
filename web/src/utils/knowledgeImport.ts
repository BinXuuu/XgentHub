// 知识库批量导入：一个 .md / .txt 文件变成一条（太长就拆成几条）知识。

/** 服务端一条知识最多存 12000 字，这里留点余量。 */
const MAX_ENTRY_CHARS = 11000;
export const IMPORTABLE_EXTENSIONS = [".md", ".markdown", ".txt"];

export interface ImportedEntry {
  title: string;
  content: string;
}

export function isImportableFile(name: string): boolean {
  const lower = name.toLowerCase();
  return IMPORTABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** 标题：优先用文件里第一个 Markdown 标题（# xxx），没有就用去掉扩展名的文件名。 */
function pickTitle(fileName: string, text: string): string {
  const heading = text.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m)?.[1]?.trim();
  const base = fileName.replace(/\.[^.]+$/, "").trim();
  return (heading || base || "未命名").slice(0, 150);
}

/** 按段落（空行）切块，每块不超过 MAX_ENTRY_CHARS；单个段落本身太长就硬切。 */
function splitIntoChunks(text: string): string[] {
  if (text.length <= MAX_ENTRY_CHARS) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n\s*\n/)) {
    const piece = paragraph.trim();
    if (!piece) continue;
    if (piece.length > MAX_ENTRY_CHARS) {
      if (current) chunks.push(current);
      current = "";
      for (let i = 0; i < piece.length; i += MAX_ENTRY_CHARS) chunks.push(piece.slice(i, i + MAX_ENTRY_CHARS));
      continue;
    }
    if (current && current.length + piece.length + 2 > MAX_ENTRY_CHARS) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function fileToKnowledgeEntries(fileName: string, rawText: string): ImportedEntry[] {
  const text = rawText.replace(/^﻿/, "").replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  const title = pickTitle(fileName, text);
  const chunks = splitIntoChunks(text);
  if (chunks.length === 1) return [{ title, content: chunks[0] }];
  return chunks.map((content, index) => ({ title: `${title}（${index + 1}/${chunks.length}）`, content }));
}
