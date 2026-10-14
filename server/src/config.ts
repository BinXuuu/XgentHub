import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveClaudeCodeBin } from "./adapters/claudeBinary.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(serverRoot, "..");

// 兼容从仓库根目录（推荐，.env 放在 D:\Agent\AgentHub\.env）或直接在 server/ 目录下运行两种方式。
for (const envPath of [path.join(repoRoot, ".env"), path.join(serverRoot, ".env")]) {
  if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 4180),
  adminToken: process.env.ADMIN_TOKEN ?? "",
  dbPath: path.resolve(serverRoot, process.env.DB_PATH ?? "./data/agenthub.sqlite"),
  /** 数据库所在目录，其它 JSON 存储、附件、用量缓存都放这里；测试用临时 DB_PATH 时会跟着一起隔离，不会写进真实数据。 */
  dataDir: path.dirname(path.resolve(serverRoot, process.env.DB_PATH ?? "./data/agenthub.sqlite")),
  serverRoot,

  allowLanBind: bool(process.env.ALLOW_LAN_BIND, false),

  openclaw: {
    bin: process.env.OPENCLAW_BIN ?? "openclaw",
    agentId: process.env.OPENCLAW_AGENT_ID ?? "",
    timeoutSec: Number(process.env.OPENCLAW_TIMEOUT ?? 600),
    idleTimeoutSec: Number(process.env.OPENCLAW_IDLE_TIMEOUT ?? 600),
  },
  codex: {
    bin: process.env.CODEX_BIN ?? "codex",
    // read-only | workspace-write | danger-full-access（见 `codex exec --help`）
    sandboxMode: process.env.CODEX_SANDBOX_MODE ?? "workspace-write",
    timeoutSec: Number(process.env.CODEX_TIMEOUT ?? 900),
  },
  claudeCode: {
    /** 用户配置的值（.env / 配置页里填的），配置页显示和保存都用它。 */
    configuredBin: process.env.CLAUDE_CODE_BIN ?? "claude",
    /** 实际要启动的程序：桌面版自带的 claude.exe 按版本存放，每次取时自动换成最新版本（见 adapters/claudeBinary.ts）。 */
    get bin(): string {
      return resolveClaudeCodeBin(this.configuredBin);
    },
    set bin(value: string) {
      this.configuredBin = value;
    },
    // --verbose 是必须的：claude CLI 在 --print + --output-format=stream-json 时如果不带 --verbose 会直接报错拒绝执行
    args: (process.env.CLAUDE_CODE_ARGS ?? "--print --output-format stream-json --verbose").split(" ").filter(Boolean),
  },
  antigravity: {
    bin: process.env.ANTIGRAVITY_BIN ?? "agy",
    defaultModel: process.env.ANTIGRAVITY_MODEL ?? "",
    effort: process.env.ANTIGRAVITY_EFFORT ?? "",
    printTimeout: process.env.ANTIGRAVITY_PRINT_TIMEOUT ?? "100m",
    timeoutSec: Number(process.env.ANTIGRAVITY_TIMEOUT ?? 6000),
  },
  arkCli: {
    bin: process.env.ARK_CLI_BIN ?? "arkcli",
    profile: process.env.ARK_CLI_PROFILE ?? "",
    apiKey: process.env.ARK_CLI_API_KEY || process.env.ARK_API_KEY || "",
    baseUrl: process.env.ARK_CLI_BASE_URL || process.env.ARK_BASE_URL || "",
    defaultModel: process.env.ARK_CLI_MODEL || process.env.ARK_MODEL || "",
    reasoningEffort: process.env.ARK_CLI_REASONING_EFFORT ?? "",
    timeoutSec: Number(process.env.ARK_CLI_TIMEOUT ?? 900),
  },
  hermes: {
    baseUrl: process.env.HERMES_BASE_URL ?? "http://127.0.0.1:8000",
    apiKey: process.env.HERMES_API_KEY ?? "",
    model: process.env.HERMES_MODEL ?? "hermes",
  },
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
    defaultModel: process.env.OLLAMA_MODEL ?? "",
    keepAlive: process.env.OLLAMA_KEEP_ALIVE?.trim() ?? "",
  },
  tokenezgo: {
    baseUrl: process.env.TOKENEZGO_BASE_URL ?? "https://tokenezgo.com/v1",
    apiKey: process.env.TOKENEZGO_API_KEY ?? "",
    defaultModel: process.env.TOKENEZGO_MODEL ?? "",
  },
  doubao: {
    baseUrl: process.env.DOUBAO_BASE_URL || process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3",
    apiKey: process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY || "",
    defaultModel: process.env.DOUBAO_MODEL || process.env.ARK_MODEL || "",
  },
};

if (config.host !== "127.0.0.1" && config.host !== "localhost" && !config.allowLanBind) {
  console.warn(
    `[security] HOST 被设置为 "${config.host}"，默认仅允许 127.0.0.1。` +
      `如需局域网/其他绑定，请显式设置 ALLOW_LAN_BIND=true（不建议直接暴露公网，请使用 Tailscale/Cloudflare Tunnel）。`
  );
  config.host = "127.0.0.1";
}
