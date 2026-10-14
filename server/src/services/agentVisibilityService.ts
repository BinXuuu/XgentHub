import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";

const storePath = path.join(config.dataDir, "hidden-agents.json");

function readHiddenIds(): string[] {
  if (!fs.existsSync(storePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function writeHiddenIds(ids: string[]) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify([...new Set(ids)].sort(), null, 2) + "\n", "utf8");
}

export function isAgentHidden(agentId: string): boolean {
  return readHiddenIds().includes(agentId);
}

export function hideAgent(agentId: string): void {
  writeHiddenIds([...readHiddenIds(), agentId]);
}

export { storePath as hiddenAgentStorePath };
