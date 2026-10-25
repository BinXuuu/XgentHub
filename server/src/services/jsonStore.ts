import fs from "node:fs";
import path from "node:path";

// 配置文件（账号、MCP、自定义 Agent、资源库、.env……）的安全读写。
// 以前是直接覆盖写：写到一半断电或进程被杀，文件就只剩半截；读的时候解析失败又直接当成"空列表"，
// 下一次保存再把坏文件覆盖掉——账号、MCP 这些就"全部消失"且找不回来。
// 现在：写的时候先写临时文件再整体替换，并把上一版留成 <文件>.bak；
// 读到坏文件时，坏的那份改名留存（<文件>.corrupt-<时间>），能用 .bak 恢复就自动恢复。

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function writeTextAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  } catch {
    // 备份失败不影响这次保存
  }
  fs.renameSync(tmp, file);
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeTextAtomic(file, JSON.stringify(value, null, 2) + "\n");
}

function parse<T>(file: string, isValid?: (value: unknown) => boolean): T {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (isValid && !isValid(value)) throw new Error("内容格式不对");
  return value as T;
}

/**
 * 读 JSON 配置。文件不存在返回 fallback；文件坏了先尝试用上一版 .bak 恢复，恢复不了也把坏文件改名留着（不会被下次保存覆盖），再返回 fallback。
 */
export function readJsonFile<T>(file: string, fallback: T, isValid?: (value: unknown) => boolean): T {
  if (!fs.existsSync(file)) return fallback;
  try {
    return parse<T>(file, isValid);
  } catch (err) {
    const corrupt = `${file}.corrupt-${stamp()}`;
    try {
      fs.renameSync(file, corrupt);
    } catch {
      return fallback;
    }
    const backup = `${file}.bak`;
    try {
      const restored = parse<T>(backup, isValid);
      fs.copyFileSync(backup, file);
      console.warn(`[config] ${path.basename(file)} 损坏（${(err as Error).message}），已用上一版恢复；坏文件留在 ${corrupt}`);
      return restored;
    } catch {
      console.warn(`[config] ${path.basename(file)} 损坏（${(err as Error).message}），也没有可用的上一版；坏文件留在 ${corrupt}`);
      return fallback;
    }
  }
}
