import path from "node:path";
import { config } from "../config.ts";
import { readJsonFile, writeJsonAtomic } from "./jsonStore.ts";

// 账号备注：只在 Xgent 里显示（左边栏括号里、账号区「备注」一行），默认账号也能写。空着就照旧显示邮箱 / 账号名。
const storePath = path.join(config.dataDir, "account-notes.json");

function readNotes(): Record<string, string> {
  const parsed = readJsonFile<Record<string, unknown>>(storePath, {}, (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value));
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1].trim())));
}

export function getAccountNote(agentId: string): string | null {
  return readNotes()[agentId] ?? null;
}

export function setAccountNote(agentId: string, note: string): void {
  const notes = readNotes();
  const value = note.trim().slice(0, 60);
  if (value) notes[agentId] = value;
  else delete notes[agentId];
  writeJsonAtomic(storePath, notes);
}

export function deleteAccountNote(agentId: string): void {
  const notes = readNotes();
  if (!(agentId in notes)) return;
  delete notes[agentId];
  writeJsonAtomic(storePath, notes);
}
