import path from "node:path";
import { config } from "../config.ts";
import { readJsonFile, writeJsonAtomic } from "./jsonStore.ts";

const storePath = path.join(config.dataDir, "hidden-agents.json");

function readHiddenIds(): string[] {
  const parsed = readJsonFile<unknown[]>(storePath, [], Array.isArray);
  return (parsed as any[]).filter((item) => typeof item === "string");
}

function writeHiddenIds(ids: string[]) {
  writeJsonAtomic(storePath, [...new Set(ids)].sort());
}

export function isAgentHidden(agentId: string): boolean {
  return readHiddenIds().includes(agentId);
}

export function hideAgent(agentId: string): void {
  writeHiddenIds([...readHiddenIds(), agentId]);
}

/** 删掉的内置 Agent 只是藏起来了，「新增 Agent」页可以把它找回来。 */
export function unhideAgent(agentId: string): void {
  writeHiddenIds(readHiddenIds().filter((id) => id !== agentId));
}

export { storePath as hiddenAgentStorePath };
