import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.ts";
import { resolveCliBinary } from "../adapters/winSpawn.ts";
import { updateAgentConfig } from "./agentConfigService.ts";
import { pickConfigBundleWindows } from "./folderPicker.ts";
import type {
  AgentDiagnosticStatus,
  ConfigExportResult,
  ConfigImportInput,
  MachineConfigApplyInput,
  MachineConfigApplyResult,
  MachineConfigDiscovery,
  MachineConfigDiscoveryItem,
  MachineConfigDiscoveryStatus,
  PostInstallCheck,
  PostInstallStatus,
  RemoteAccessStatus,
  ShortcutStatus,
  StartupTaskStatus,
  SystemCommandResult,
  SystemPathKind,
} from "../types.ts";

const root = path.resolve(config.serverRoot, "..");
const productName = "Xgent Hub";
const taskName = `${productName} Auto Start`;
const legacyTaskNames = ["AgentHub Auto Start"];
const taskNames = [taskName, ...legacyTaskNames];
const logsDir = path.join(root, "logs");
const backupsDir = path.join(root, "backups");
const envPath = path.join(root, ".env");
const startMenuBaseDir = path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs");
const startMenuDir = path.join(startMenuBaseDir, productName);
const legacyStartMenuDir = path.join(startMenuBaseDir, "AgentHub");
const desktopShortcut = path.join(os.homedir(), "Desktop", `${productName}.lnk`);
const legacyDesktopShortcut = path.join(os.homedir(), "Desktop", "AgentHub.lnk");
const startMenuShortcut = path.join(startMenuDir, `${productName}.lnk`);
const startMenuStatusShortcut = path.join(startMenuDir, `${productName} Status.lnk`);
const startMenuStopShortcut = path.join(startMenuDir, `Stop ${productName}.lnk`);
const legacyStartMenuShortcut = path.join(legacyStartMenuDir, "AgentHub.lnk");
const legacyStartMenuStatusShortcut = path.join(legacyStartMenuDir, "AgentHub Status.lnk");
const legacyStartMenuStopShortcut = path.join(legacyStartMenuDir, "Stop AgentHub.lnk");

function now(): string {
  return new Date().toISOString();
}

function localStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function runFile(file: string, args: string[] = [], timeoutMs = 120_000): Promise<SystemCommandResult> {
  const startedAt = now();
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: root,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024 * 2,
      },
      (err, stdout, stderr) => {
        const exitCode = typeof (err as NodeJS.ErrnoException | null)?.code === "number" ? Number((err as NodeJS.ErrnoException).code) : err ? 1 : 0;
        resolve({
          ok: !err,
          exitCode,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          startedAt,
          finishedAt: now(),
        });
      }
    );
  });
}

function runPowerShellScript(scriptRelativePath: string, args: string[] = [], timeoutMs = 120_000): Promise<SystemCommandResult> {
  const scriptPath = path.join(root, scriptRelativePath);
  return runFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args], timeoutMs);
}

function commandResult(ok: boolean, stdout: string, stderr = "", exitCode: number | null = ok ? 0 : 1): SystemCommandResult {
  const stamp = now();
  return { ok, exitCode, stdout, stderr, startedAt: stamp, finishedAt: stamp };
}

function readDotEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  if (!fs.existsSync(envPath)) return values;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    values[key] = value;
  }
  return values;
}

function uniqueExisting(candidates: string[]): string[] {
  const seen = new Set<string>();
  return candidates
    .filter(Boolean)
    .map((candidate) => path.normalize(candidate))
    .filter((candidate) => {
      const key = candidate.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return fs.existsSync(candidate);
    });
}

function npmShimCandidates(command: string): string[] {
  const npmRoot = process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : "";
  return npmRoot ? [path.join(npmRoot, `${command}.cmd`), path.join(npmRoot, `${command}.exe`), path.join(npmRoot, `${command}.ps1`)] : [];
}

function discoverCommand(command: string, extraCandidates: string[] = []): { value: string; source: string } | null {
  const resolved = resolveCliBinary(command);
  if (resolved) return { value: resolved, source: "PATH" };

  const candidates = uniqueExisting([...extraCandidates, ...npmShimCandidates(command)]);
  if (candidates[0]) return { value: candidates[0], source: "known-path" };

  return null;
}

function discoverClaudeCode(): { value: string; source: string } | null {
  const pathResult = discoverCommand("claude");
  if (pathResult) return pathResult;

  const packageRoot = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Packages") : "";
  const candidates: string[] = [];
  if (packageRoot && fs.existsSync(packageRoot)) {
    for (const packageName of fs.readdirSync(packageRoot).filter((name) => name.toLowerCase().startsWith("claude_"))) {
      const versionsRoot = path.join(packageRoot, packageName, "LocalCache", "Roaming", "Claude", "claude-code");
      if (!fs.existsSync(versionsRoot)) continue;
      for (const version of fs.readdirSync(versionsRoot)) {
        const versionRoot = path.join(versionsRoot, version);
        candidates.push(path.join(versionRoot, "claude.exe"));
        try {
          for (const entry of fs.readdirSync(versionRoot, { withFileTypes: true })) {
            if (entry.isDirectory()) candidates.push(path.join(versionRoot, entry.name, "claude.exe"));
          }
        } catch {
          // Ignore partially removed version directories while Claude Desktop is updating.
        }
      }
    }
  }

  const existing = uniqueExisting(candidates).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return existing[0] ? { value: existing[0], source: "Claude Desktop" } : null;
}

function isDefaultCliValue(value: string, defaults: string[]): boolean {
  const normalized = value.trim().toLowerCase();
  return !normalized || defaults.map((item) => item.toLowerCase()).includes(normalized);
}

function isUsableCurrentValue(value: string): boolean {
  if (!value.trim()) return false;
  if (path.isAbsolute(value) || value.includes("\\") || value.includes("/")) return fs.existsSync(value);
  return Boolean(resolveCliBinary(value));
}

function samePathOrValue(a: string, b: string): boolean {
  if (!a || !b) return false;
  return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase() || a.trim().toLowerCase() === b.trim().toLowerCase();
}

function makeItem(input: {
  id: string;
  agentId?: string;
  label: string;
  envKey: string;
  currentValue: string;
  discoveredValue?: string;
  source?: string;
  defaults?: string[];
  manualNote?: string;
}): MachineConfigDiscoveryItem {
  const currentValue = input.currentValue.trim();
  const discoveredValue = input.discoveredValue?.trim() ?? "";
  let status: MachineConfigDiscoveryStatus;
  let note: string;

  if (!discoveredValue) {
    status = input.manualNote ? "manual" : "not_found";
    note = input.manualNote ?? "未在本机常见位置发现，请手动安装或填写路径。";
  } else if (samePathOrValue(currentValue, discoveredValue) || isUsableCurrentValue(currentValue)) {
    // 当前写的是命令名（比如 codex）、本机能找到，就已经能用了，不再标成"可覆盖"引导用户去改。
    status = "configured";
    note = samePathOrValue(currentValue, discoveredValue)
      ? "当前配置已经指向发现路径。"
      : `当前配置可用（实际找到的是 ${discoveredValue}），不需要改。`;
  } else if (isDefaultCliValue(currentValue, input.defaults ?? [])) {
    status = "recommended";
    note = "建议写入完整路径，便于换环境后 doctor 和后台服务稳定识别。";
  } else {
    status = "recommended";
    note = "当前配置不可用，建议改成本机发现路径。";
  }

  return {
    id: input.id,
    agentId: input.agentId,
    label: input.label,
    envKey: input.envKey,
    currentValue,
    discoveredValue,
    source: input.source ?? "",
    status,
    note,
  };
}

async function detectOllamaBaseUrl(currentValue: string): Promise<MachineConfigDiscoveryItem> {
  const defaultUrl = "http://127.0.0.1:11434";
  const currentUrl = currentValue.trim() || defaultUrl;
  const currentOk = await testHttpOk(`${currentUrl.replace(/\/$/, "")}/api/tags`);
  const defaultOk = currentUrl === defaultUrl ? currentOk : await testHttpOk(`${defaultUrl}/api/tags`);
  const discoveredValue = defaultOk ? defaultUrl : currentOk ? currentUrl : "";
  const item = makeItem({
    id: "ollama-base-url",
    agentId: "ollama",
    label: "Ollama 本地服务",
    envKey: "OLLAMA_BASE_URL",
    currentValue,
    discoveredValue,
    source: discoveredValue ? "HTTP health" : "",
    defaults: [defaultUrl],
  });
  if (item.status === "not_found") item.note = "未检测到 Ollama API；如需本地模型，请先启动 Ollama。";
  return item;
}

export async function getMachineConfigDiscovery(): Promise<MachineConfigDiscovery> {
  const envMap = readDotEnv();
  const codex = discoverCommand("codex");
  const openclaw = discoverCommand("openclaw");
  const claudeCode = discoverClaudeCode();
  const antigravity = discoverCommand("agy", [process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe") : ""]);
  const arkCli = discoverCommand("arkcli");

  const items: MachineConfigDiscoveryItem[] = [
    makeItem({
      id: "codex-bin",
      agentId: "codex",
      label: "Codex CLI",
      envKey: "CODEX_BIN",
      currentValue: envMap.CODEX_BIN ?? config.codex.bin,
      discoveredValue: codex?.value,
      source: codex?.source,
      defaults: ["codex"],
    }),
    makeItem({
      id: "openclaw-bin",
      agentId: "openclaw",
      label: "OpenClaw CLI",
      envKey: "OPENCLAW_BIN",
      currentValue: envMap.OPENCLAW_BIN ?? config.openclaw.bin,
      discoveredValue: openclaw?.value,
      source: openclaw?.source,
      defaults: ["openclaw"],
    }),
    makeItem({
      id: "claude-code-bin",
      agentId: "claude-code",
      label: "Claude Code CLI",
      envKey: "CLAUDE_CODE_BIN",
      currentValue: envMap.CLAUDE_CODE_BIN ?? config.claudeCode.bin,
      discoveredValue: claudeCode?.value,
      source: claudeCode?.source,
      defaults: ["claude"],
    }),
    makeItem({
      id: "antigravity-bin",
      agentId: "antigravity",
      label: "Antigravity CLI",
      envKey: "ANTIGRAVITY_BIN",
      currentValue: envMap.ANTIGRAVITY_BIN ?? config.antigravity.bin,
      discoveredValue: antigravity?.value,
      source: antigravity?.source,
      defaults: ["agy"],
    }),
    makeItem({
      id: "ark-cli-bin",
      agentId: "ark-cli",
      label: "Ark CLI",
      envKey: "ARK_CLI_BIN",
      currentValue: envMap.ARK_CLI_BIN ?? config.arkCli.bin,
      discoveredValue: arkCli?.value,
      source: arkCli?.source,
      defaults: ["arkcli"],
    }),
    await detectOllamaBaseUrl(envMap.OLLAMA_BASE_URL ?? config.ollama.baseUrl),
    makeItem({
      id: "api-keys",
      label: "API 中转站 / 云模型密钥",
      envKey: "API_KEYS",
      currentValue: "",
      manualNote: "推荐 API 中转站、Hermes、豆包和自定义 API 的 Key 不会自动发现，需要在对应 Agent 配置页手动填写。",
    }),
  ];

  const summary = items.reduce(
    (acc, item) => {
      if (item.status === "not_found") acc.notFound += 1;
      else if (item.status === "manual") acc.manual += 1;
      else acc[item.status] += 1;
      if (item.status === "recommended" || item.status === "different") acc.applicable += 1;
      return acc;
    },
    { configured: 0, recommended: 0, different: 0, notFound: 0, manual: 0, applicable: 0 }
  );

  return { updatedAt: now(), envPath, items, summary };
}

export async function applyMachineConfig(input: MachineConfigApplyInput): Promise<MachineConfigApplyResult> {
  const startedAt = now();
  const discovery = await getMachineConfigDiscovery();
  const selectedKeys = new Set(input.keys?.filter(Boolean) ?? []);
  const overwrite = Boolean(input.overwrite);
  const applied: MachineConfigApplyResult["applied"] = [];
  const skipped: MachineConfigApplyResult["skipped"] = [];
  const byAgent = new Map<string, Record<string, string>>();

  for (const item of discovery.items) {
    if (selectedKeys.size > 0 && !selectedKeys.has(item.envKey)) continue;
    if (!item.agentId) {
      skipped.push({ envKey: item.envKey, reason: "此项需要手动配置。" });
      continue;
    }
    if (!item.discoveredValue) {
      skipped.push({ envKey: item.envKey, reason: "没有发现可写入的值。" });
      continue;
    }
    if (item.status === "configured") {
      skipped.push({ envKey: item.envKey, reason: "当前已配置。" });
      continue;
    }
    if (item.status === "different" && !overwrite) {
      skipped.push({ envKey: item.envKey, reason: "当前值可用，未启用覆盖。" });
      continue;
    }

    const values = byAgent.get(item.agentId) ?? {};
    values[item.envKey] = item.discoveredValue;
    byAgent.set(item.agentId, values);
    applied.push({ envKey: item.envKey, value: item.discoveredValue, previousValue: item.currentValue });
  }

  for (const [agentId, values] of byAgent) {
    updateAgentConfig(agentId, values);
  }

  const nextDiscovery = await getMachineConfigDiscovery();
  const stdout =
    applied.length > 0
      ? `已写入 ${applied.length} 项本机配置：${applied.map((item) => item.envKey).join(", ")}`
      : "没有需要写入的本机配置。";
  return {
    ok: true,
    exitCode: 0,
    stdout,
    stderr: skipped.length > 0 ? skipped.map((item) => `${item.envKey}: ${item.reason}`).join("\n") : "",
    startedAt,
    finishedAt: now(),
    applied,
    skipped,
    discovery: nextDiscovery,
  };
}

async function testHttpOk(url: string, timeoutMs = 1800): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function check(id: string, title: string, status: AgentDiagnosticStatus, description: string): PostInstallCheck {
  return { id, title, status, description };
}

export async function runDoctor(): Promise<SystemCommandResult> {
  return runPowerShellScript("scripts/doctor.ps1", [], 180_000);
}

export async function exportSafeConfig(): Promise<ConfigExportResult> {
  const name = `XgentHub-config-ui-${localStamp()}`;
  const result = await runPowerShellScript("scripts/export-config.ps1", ["-Name", name, "-Zip"], 120_000);
  const bundlePath = path.join(root, "backups", name);
  const zipPath = `${bundlePath}.zip`;
  return { ...result, bundlePath, zipPath };
}

export async function importConfig(input: ConfigImportInput): Promise<SystemCommandResult> {
  const bundlePath = String(input.bundlePath ?? "").trim();
  if (!bundlePath) {
    return {
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "Bundle path is required.",
      startedAt: now(),
      finishedAt: now(),
    };
  }

  const args = ["-BundlePath", bundlePath];
  if (input.restoreSecrets) args.push("-RestoreSecrets");
  if (input.restoreDatabase) args.push("-RestoreDatabase");
  return runPowerShellScript("scripts/import-config.ps1", args, 120_000);
}

export async function pickConfigBundle(): Promise<{ path: string | null }> {
  return { path: await pickConfigBundleWindows() };
}

export async function getStartupTaskStatus(): Promise<StartupTaskStatus> {
  for (const name of taskNames) {
    const result = await runFile("schtasks.exe", ["/Query", "/TN", name, "/FO", "LIST"], 30_000);
    if (result.ok) {
      return {
        taskName: name,
        installed: true,
        detail: result.stdout.trim(),
      };
    }
  }
  return {
    taskName,
    installed: false,
    detail: "未安装开机启动任务",
  };
}

export async function installStartupTask(): Promise<SystemCommandResult> {
  return runPowerShellScript("install-startup-task.ps1", [], 60_000);
}

export async function uninstallStartupTask(): Promise<SystemCommandResult> {
  const startedAt = now();
  const removed: string[] = [];
  const errors: string[] = [];
  for (const name of taskNames) {
    const query = await runFile("schtasks.exe", ["/Query", "/TN", name, "/FO", "LIST"], 30_000);
    if (!query.ok) continue;
    const result = await runFile("schtasks.exe", ["/Delete", "/F", "/TN", name], 60_000);
    if (result.ok) removed.push(name);
    else errors.push(`${name}: ${result.stderr || result.stdout || "删除失败"}`);
  }
  return {
    ok: errors.length === 0,
    exitCode: errors.length === 0 ? 0 : 1,
    stdout: removed.length ? `已移除开机启动任务：${removed.join(", ")}` : "没有发现可移除的开机启动任务。",
    stderr: errors.join("\n"),
    startedAt,
    finishedAt: now(),
  };
}

export async function getShortcutStatus(): Promise<ShortcutStatus> {
  const desktopInstalled = fs.existsSync(desktopShortcut) || fs.existsSync(legacyDesktopShortcut);
  const startMenuInstalled =
    (fs.existsSync(startMenuShortcut) && fs.existsSync(startMenuStatusShortcut) && fs.existsSync(startMenuStopShortcut)) ||
    (fs.existsSync(legacyStartMenuShortcut) && fs.existsSync(legacyStartMenuStatusShortcut) && fs.existsSync(legacyStartMenuStopShortcut));
  return {
    desktopShortcut,
    desktopInstalled,
    startMenuDir,
    startMenuInstalled,
    installed: desktopInstalled && startMenuInstalled,
  };
}

export async function installShortcuts(): Promise<SystemCommandResult> {
  return runPowerShellScript("scripts/manage-shortcuts.ps1", ["install"], 60_000);
}

export async function uninstallShortcuts(): Promise<SystemCommandResult> {
  return runPowerShellScript("scripts/manage-shortcuts.ps1", ["remove"], 60_000);
}

export async function getPostInstallStatus(): Promise<PostInstallStatus> {
  const envMap = readDotEnv();
  const startup = await getStartupTaskStatus();
  const shortcuts = await getShortcutStatus();
  const healthOk = await testHttpOk("http://127.0.0.1:4180/api/health");
  const ollamaOk = await testHttpOk("http://127.0.0.1:11434/api/tags");
  const adminToken = envMap.ADMIN_TOKEN;
  const machineConfig = await getMachineConfigDiscovery();
  const machineReady = machineConfig.summary.recommended === 0 && machineConfig.summary.notFound === 0;

  return {
    updatedAt: now(),
    root,
    logsDir,
    backupsDir,
    webUrl: "http://127.0.0.1:4180",
    checks: [
      check(
        "admin-token",
        "管理员令牌",
        adminToken && adminToken !== "change-me-please" ? "ok" : "warn",
        adminToken && adminToken !== "change-me-please" ? "ADMIN_TOKEN 已配置。" : "建议在 LAN / Tailscale 访问前设置真实 ADMIN_TOKEN。"
      ),
      check(
        "web-build",
        "生产前端构建",
        fs.existsSync(path.join(root, "web", "dist", "index.html")) ? "ok" : "warn",
        fs.existsSync(path.join(root, "web", "dist", "index.html")) ? "web/dist 可用，生产模式可以托管前端。" : "尚未生成 web/dist，运行 npm run build 或 install.bat。"
      ),
      check("agenthub-health", "Xgent Hub 健康接口", healthOk ? "ok" : "warn", healthOk ? "4180 健康接口正常。" : "4180 健康接口未响应，可启动或安全重启生产服务。"),
      check("ollama-health", "Ollama 本地服务", ollamaOk ? "ok" : "warn", ollamaOk ? "Ollama API 正常。" : "Ollama 未响应；如需本地模型，请启动 Ollama。"),
      check(
        "machine-config",
        "本机 Agent 路径",
        machineReady ? "ok" : "warn",
        machineReady
          ? `已识别 ${machineConfig.summary.configured} 项本机配置；${machineConfig.summary.different} 项可按需覆盖为完整路径。`
          : `还有 ${machineConfig.summary.recommended} 项建议写入、${machineConfig.summary.notFound} 项未发现。`
      ),
      check("shortcuts", "桌面/开始菜单快捷方式", shortcuts.installed ? "ok" : "warn", shortcuts.installed ? "桌面和开始菜单快捷方式已创建。" : "可在配置中心或 manage-shortcuts.bat 中创建快捷方式。"),
      check("startup-task", "开机后台启动", startup.installed ? "ok" : "warn", startup.installed ? "Windows 任务计划启动项已安装。" : "可按需安装当前用户登录后后台启动。"),
      check("logs-dir", "日志目录", fs.existsSync(logsDir) ? "ok" : "warn", fs.existsSync(logsDir) ? logsDir : "logs 目录不存在，启动服务后会自动创建。"),
      check("backups-dir", "备份目录", fs.existsSync(backupsDir) ? "ok" : "warn", fs.existsSync(backupsDir) ? backupsDir : "backups 目录不存在，生成配置包或发布包时会创建。"),
    ],
  };
}

export function getRemoteAccessStatus(): RemoteAccessStatus {
  const envMap = readDotEnv();
  const host = config.host;
  const port = config.port;
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  const boundForLan = host === "0.0.0.0" || host === "::" || !loopbackHosts.has(host);
  const adminToken = envMap.ADMIN_TOKEN ?? config.adminToken;
  const adminTokenConfigured = Boolean(adminToken && adminToken !== "change-me-please");
  const lanUrls = Object.entries(os.networkInterfaces())
    .flatMap(([name, entries]) =>
      (entries ?? [])
        .filter((item) => item.family === "IPv4" && !item.internal)
        .map((item) => ({
          name,
          address: item.address,
          url: `http://${item.address}:${port}`,
        }))
    )
    .sort((a, b) => a.address.localeCompare(b.address));
  const warnings: string[] = [];
  const notes: string[] = [];

  if (!adminTokenConfigured) warnings.push("ADMIN_TOKEN 未设置为真实值；开启局域网或隧道访问前必须先设置。");
  if (!boundForLan) warnings.push("当前只绑定本机地址，手机不能直接通过局域网 IP 访问。");
  if (boundForLan && !config.allowLanBind && !loopbackHosts.has(host)) {
    warnings.push("HOST 是非本机地址，但 ALLOW_LAN_BIND 未启用；启动时可能会被安全保护退回 127.0.0.1。");
  }
  if (lanUrls.length === 0) warnings.push("没有发现可用的 IPv4 局域网地址。");

  notes.push(boundForLan ? "手机可尝试打开下方局域网地址；仍建议只在可信网络或 Tailscale 内使用。" : "如需手机访问，可设置 HOST=0.0.0.0 和 ALLOW_LAN_BIND=true 后重启服务。");
  notes.push("文件选择器会在主机上弹窗；手机远程访问时仍需要在电脑上完成选择。");

  return {
    updatedAt: now(),
    host,
    port,
    localUrl: `http://127.0.0.1:${port}`,
    boundForLan,
    allowLanBind: config.allowLanBind,
    adminTokenConfigured,
    lanUrls,
    warnings,
    notes,
  };
}

export async function requestSafeRestart(): Promise<SystemCommandResult> {
  return runPowerShellScript("scripts/installer-entry.ps1", ["restart-prod"], 30_000);
}

export async function openSystemPath(kind: SystemPathKind): Promise<SystemCommandResult> {
  const commandByKind: Record<SystemPathKind, string> = {
    root: "open-root",
    logs: "open-logs",
    backups: "open-backups",
  };
  const command = commandByKind[kind];
  if (!command) return commandResult(false, "", `Unsupported path kind: ${kind}`);
  return runPowerShellScript("scripts/installer-entry.ps1", [command], 30_000);
}
