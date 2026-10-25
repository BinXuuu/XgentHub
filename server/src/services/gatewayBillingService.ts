import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { config } from "../config.ts";
import { readJsonFile, writeJsonAtomic } from "./jsonStore.ts";

export interface GatewayBillingSettings {
  defaultTaskBudgetCny: number;
  monthlyBudgetCny: number;
  inputPriceCnyPer1K: number;
  outputPriceCnyPer1K: number;
  modelPriceRules: GatewayModelPriceRule[];
}

export interface GatewayModelPriceRule {
  id: string;
  label: string;
  pattern: string;
  inputPriceCnyPer1K: number;
  outputPriceCnyPer1K: number;
  enabled: boolean;
}

export interface GatewayUsageRecord {
  id: string;
  provider: "tokenezgo";
  taskId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostCny: number;
  budgetLimitCny: number | null;
  priceConfigured: boolean;
  budgetExceeded: boolean;
  priceRuleLabel: string;
  createdAt: string;
  note: string;
}

export interface GatewayUsageSummary {
  monthKey: string;
  recordCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostCny: number;
}

export interface GatewayPriceRow {
  id: string;
  label: string;
  pattern: string;
  inputPriceCnyPer1K: number;
  outputPriceCnyPer1K: number;
  configured: boolean;
  enabled: boolean;
  note: string;
}

export interface GatewayTaskUsage {
  taskId: string;
  summary: GatewayUsageSummary;
  records: GatewayUsageRecord[];
}

export interface GatewayCloudAccountStatus {
  provider: "tokenezgo";
  status: "external_only";
  signedIn: false;
  loginSupported: false;
  accountLabel: string;
  balanceLabel: string;
  billingUrl: string;
  reservedCapabilities: string[];
  notes: string[];
}

export interface GatewayOverview {
  provider: "tokenezgo";
  name: string;
  baseUrl: string;
  billingUrl: string;
  apiKeyConfigured: boolean;
  balanceMode: "external";
  balanceLabel: string;
  balanceUrl: string;
  settings: GatewayBillingSettings;
  month: GatewayUsageSummary;
  recentRecords: GatewayUsageRecord[];
  priceTable: GatewayPriceRow[];
  notices: string[];
  updatedAt: string;
}

const dataDir = config.dataDir;
const settingsPath = path.join(dataDir, "gateway-settings.json");
const ledgerPath = path.join(dataDir, "gateway-usage-ledger.json");

const defaultSettings: GatewayBillingSettings = {
  defaultTaskBudgetCny: 0,
  monthlyBudgetCny: 0,
  inputPriceCnyPer1K: 0,
  outputPriceCnyPer1K: 0,
  modelPriceRules: [],
};

function now(): string {
  return new Date().toISOString();
}

function monthKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function ensureDataDir() {
  fs.mkdirSync(dataDir, { recursive: true });
}

function readJson<T>(file: string, fallback: T): T {
  return readJsonFile<T>(file, fallback);
}

function writeJson(file: string, value: unknown) {
  ensureDataDir();
  writeJsonAtomic(file, value);
}

function cleanMoney(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 10000) / 10000;
}

function cleanInt(value: number): number {
  return Math.max(0, Math.round(value));
}

function roundMoney(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function wildcardMatches(pattern: string, value: string): boolean {
  const normalizedPattern = pattern.trim().toLowerCase();
  const normalizedValue = value.trim().toLowerCase();
  if (!normalizedPattern || !normalizedValue) return false;
  if (normalizedPattern === normalizedValue) return true;
  const escaped = normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(normalizedValue);
}

function cleanRule(raw: Partial<GatewayModelPriceRule>, index: number): GatewayModelPriceRule | null {
  const pattern = String(raw.pattern ?? "").trim();
  if (!pattern) return null;
  const label = String(raw.label ?? pattern).trim() || pattern;
  return {
    id: String(raw.id ?? `rule-${index + 1}`).trim() || `rule-${index + 1}`,
    label,
    pattern,
    inputPriceCnyPer1K: cleanMoney(raw.inputPriceCnyPer1K),
    outputPriceCnyPer1K: cleanMoney(raw.outputPriceCnyPer1K),
    enabled: raw.enabled !== false,
  };
}

function cleanRules(raw: unknown): GatewayModelPriceRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, index) => cleanRule(item as Partial<GatewayModelPriceRule>, index)).filter(Boolean) as GatewayModelPriceRule[];
}

function priceForModel(model: string, settings = getGatewayBillingSettings()) {
  const rule = settings.modelPriceRules.find((item) => item.enabled && wildcardMatches(item.pattern, model));
  if (rule) {
    return {
      inputPriceCnyPer1K: rule.inputPriceCnyPer1K,
      outputPriceCnyPer1K: rule.outputPriceCnyPer1K,
      label: rule.label,
      configured: rule.inputPriceCnyPer1K > 0 || rule.outputPriceCnyPer1K > 0,
    };
  }
  return {
    inputPriceCnyPer1K: settings.inputPriceCnyPer1K,
    outputPriceCnyPer1K: settings.outputPriceCnyPer1K,
    label: "默认估算单价",
    configured: settings.inputPriceCnyPer1K > 0 || settings.outputPriceCnyPer1K > 0,
  };
}

export function getGatewayBillingSettings(): GatewayBillingSettings {
  const stored = readJson<Partial<GatewayBillingSettings>>(settingsPath, {});
  return {
    defaultTaskBudgetCny: cleanMoney(stored.defaultTaskBudgetCny ?? defaultSettings.defaultTaskBudgetCny),
    monthlyBudgetCny: cleanMoney(stored.monthlyBudgetCny ?? defaultSettings.monthlyBudgetCny),
    inputPriceCnyPer1K: cleanMoney(stored.inputPriceCnyPer1K ?? defaultSettings.inputPriceCnyPer1K),
    outputPriceCnyPer1K: cleanMoney(stored.outputPriceCnyPer1K ?? defaultSettings.outputPriceCnyPer1K),
    modelPriceRules: cleanRules(stored.modelPriceRules),
  };
}

export function updateGatewayBillingSettings(input: Partial<GatewayBillingSettings>): GatewayBillingSettings {
  const current = getGatewayBillingSettings();
  const next: GatewayBillingSettings = {
    defaultTaskBudgetCny: "defaultTaskBudgetCny" in input ? cleanMoney(input.defaultTaskBudgetCny) : current.defaultTaskBudgetCny,
    monthlyBudgetCny: "monthlyBudgetCny" in input ? cleanMoney(input.monthlyBudgetCny) : current.monthlyBudgetCny,
    inputPriceCnyPer1K: "inputPriceCnyPer1K" in input ? cleanMoney(input.inputPriceCnyPer1K) : current.inputPriceCnyPer1K,
    outputPriceCnyPer1K: "outputPriceCnyPer1K" in input ? cleanMoney(input.outputPriceCnyPer1K) : current.outputPriceCnyPer1K,
    modelPriceRules: "modelPriceRules" in input ? cleanRules(input.modelPriceRules) : current.modelPriceRules,
  };
  writeJson(settingsPath, next);
  return next;
}

export function estimateTokens(text: string): number {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return 0;
  // 粗估：中英文混合场景按 4 字符约 1 token 估，账本只用于本地提醒，不作为真实结算。
  return cleanInt(compact.length / 4);
}

export function estimateGatewayCostCny(promptTokens: number, completionTokens: number, settings = getGatewayBillingSettings(), model = "") {
  const price = priceForModel(model, settings);
  const inputCost = (promptTokens / 1000) * price.inputPriceCnyPer1K;
  const outputCost = (completionTokens / 1000) * price.outputPriceCnyPer1K;
  const priceConfigured = price.configured;
  return {
    estimatedCostCny: priceConfigured ? roundMoney(inputCost + outputCost) : 0,
    priceConfigured,
    priceRuleLabel: price.label,
  };
}

export function listGatewayUsageRecords(): GatewayUsageRecord[] {
  const records = readJson<GatewayUsageRecord[]>(ledgerPath, []);
  return Array.isArray(records) ? records : [];
}

export function summarizeGatewayUsage(records = listGatewayUsageRecords(), key = monthKey()): GatewayUsageSummary {
  const monthRecords = records.filter((record) => record.createdAt.startsWith(key));
  return monthRecords.reduce(
    (acc, record) => {
      acc.recordCount += 1;
      acc.promptTokens += record.promptTokens;
      acc.completionTokens += record.completionTokens;
      acc.totalTokens += record.totalTokens;
      acc.estimatedCostCny = roundMoney(acc.estimatedCostCny + record.estimatedCostCny);
      return acc;
    },
    {
      monthKey: key,
      recordCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostCny: 0,
    }
  );
}

export function summarizeGatewayRecords(records: GatewayUsageRecord[], key = monthKey()): GatewayUsageSummary {
  return records.reduce(
    (acc, record) => {
      acc.recordCount += 1;
      acc.promptTokens += record.promptTokens;
      acc.completionTokens += record.completionTokens;
      acc.totalTokens += record.totalTokens;
      acc.estimatedCostCny = roundMoney(acc.estimatedCostCny + record.estimatedCostCny);
      return acc;
    },
    {
      monthKey: key,
      recordCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostCny: 0,
    }
  );
}

export function getGatewayTaskUsage(taskId: string): GatewayTaskUsage {
  const records = listGatewayUsageRecords().filter((record) => record.taskId === taskId);
  return {
    taskId,
    summary: summarizeGatewayRecords(records),
    records: records.slice().reverse(),
  };
}

export function checkGatewayBudgetBeforeCall(input: { promptText: string; model: string; budgetLimitCny?: number | null }): { ok: true; note: string } | { ok: false; message: string } {
  const settings = getGatewayBillingSettings();
  const month = summarizeGatewayUsage();
  if (settings.monthlyBudgetCny > 0 && month.estimatedCostCny >= settings.monthlyBudgetCny) {
    return {
      ok: false,
      message: `推荐 API 中转站本地月度预算已达到 ¥${settings.monthlyBudgetCny}。这是本地估算提醒，如需继续使用，请在推荐 API 中转站配置页调高或清空月度提醒预算。`,
    };
  }

  const promptTokens = estimateTokens(input.promptText);
  const estimate = estimateGatewayCostCny(promptTokens, 0, settings, input.model);
  const budgetLimitCny = cleanMoney(input.budgetLimitCny ?? 0);
  if (budgetLimitCny > 0 && estimate.priceConfigured && estimate.estimatedCostCny > budgetLimitCny) {
    return {
      ok: false,
      message: `这次请求的输入部分本地估算已超过单任务预算：预计 ¥${estimate.estimatedCostCny}，预算 ¥${budgetLimitCny}。`,
    };
  }

  return {
    ok: true,
    note: estimate.priceConfigured
      ? `输入部分本地估算 ¥${estimate.estimatedCostCny}（${estimate.priceRuleLabel}）`
      : "尚未配置估算单价，本次只记录 token 粗估，不估算金额。",
  };
}

export function recordGatewayUsage(input: {
  taskId: string;
  model: string;
  promptText: string;
  completionText: string;
  budgetLimitCny?: number | null;
  note?: string;
}): GatewayUsageRecord {
  const settings = getGatewayBillingSettings();
  const promptTokens = estimateTokens(input.promptText);
  const completionTokens = estimateTokens(input.completionText);
  const cost = estimateGatewayCostCny(promptTokens, completionTokens, settings, input.model);
  const budgetLimitCny = input.budgetLimitCny && input.budgetLimitCny > 0 ? cleanMoney(input.budgetLimitCny) : null;
  const record: GatewayUsageRecord = {
    id: nanoid(),
    provider: "tokenezgo",
    taskId: input.taskId,
    model: input.model,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimatedCostCny: cost.estimatedCostCny,
    budgetLimitCny,
    priceConfigured: cost.priceConfigured,
    budgetExceeded: Boolean(budgetLimitCny && cost.priceConfigured && cost.estimatedCostCny > budgetLimitCny),
    priceRuleLabel: cost.priceRuleLabel,
    createdAt: now(),
    note: input.note ?? (cost.priceConfigured ? "本地估算，不代表 TokenEZGO 实际账单。" : "未配置估算单价，仅记录 token 粗估。"),
  };

  const records = listGatewayUsageRecords();
  records.push(record);
  writeJson(ledgerPath, records.slice(-2000));
  return record;
}

export function getGatewayOverview(limit = 10): GatewayOverview {
  const settings = getGatewayBillingSettings();
  const records = listGatewayUsageRecords();
  const month = summarizeGatewayUsage(records);
  const priceConfigured =
    settings.inputPriceCnyPer1K > 0 ||
    settings.outputPriceCnyPer1K > 0 ||
    settings.modelPriceRules.some((rule) => rule.enabled && (rule.inputPriceCnyPer1K > 0 || rule.outputPriceCnyPer1K > 0));
  const notices = [
    "余额和真实账单仍以 TokenEZGO 页面为准，本地账本只做提醒和产品骨架。",
    priceConfigured ? "已配置本地估算单价，可显示预计花费和预算提醒。" : "尚未配置本地估算单价；会记录 token 粗估，但金额显示为 0。",
  ];
  if (settings.monthlyBudgetCny > 0 && month.estimatedCostCny >= settings.monthlyBudgetCny) {
    notices.push("本地月度预算已达到或超过提醒线，新任务会被拦截，直到调高或清空月度预算。");
  }

  return {
    provider: "tokenezgo",
    name: "推荐 API 中转站",
    baseUrl: config.tokenezgo.baseUrl,
    billingUrl: "https://tokenezgo.com",
    apiKeyConfigured: Boolean(config.tokenezgo.apiKey),
    balanceMode: "external",
    balanceLabel: "余额和充值在 TokenEZGO 查看",
    balanceUrl: "https://tokenezgo.com",
    settings,
    month,
    recentRecords: records.slice().reverse().slice(0, limit),
    priceTable: [
      {
        id: "default",
        label: "默认估算单价",
        pattern: "*",
        inputPriceCnyPer1K: settings.inputPriceCnyPer1K,
        outputPriceCnyPer1K: settings.outputPriceCnyPer1K,
        configured: settings.inputPriceCnyPer1K > 0 || settings.outputPriceCnyPer1K > 0,
        enabled: true,
        note: "没有匹配到下方模型规则时使用。",
      },
      ...settings.modelPriceRules.map((rule) => ({
        id: rule.id,
        label: rule.label,
        pattern: rule.pattern,
        inputPriceCnyPer1K: rule.inputPriceCnyPer1K,
        outputPriceCnyPer1K: rule.outputPriceCnyPer1K,
        configured: rule.inputPriceCnyPer1K > 0 || rule.outputPriceCnyPer1K > 0,
        enabled: rule.enabled,
        note: "支持 * 通配符，例如 claude-* 或 gpt-4.1*。",
      })),
    ],
    notices,
    updatedAt: now(),
  };
}

export function getGatewayCloudAccountStatus(): GatewayCloudAccountStatus {
  return {
    provider: "tokenezgo",
    status: "external_only",
    signedIn: false,
    loginSupported: false,
    accountLabel: "暂未接入 Xgent Hub 云账号",
    balanceLabel: "请到 TokenEZGO 页面查看余额",
    billingUrl: "https://tokenezgo.com",
    reservedCapabilities: ["云端登录", "真实余额", "充值订单", "Token 包消耗", "设备绑定", "异地访问授权"],
    notes: [
      "当前版本只做接口占位和产品边界预留。",
      "本地开源客户端不会保存平台主 API Key；客户自己的 API Key 仍通过 TOKENEZGO_API_KEY 配置。",
    ],
  };
}

export function getGatewayUsageSummaryText(): string | null {
  const overview = getGatewayOverview(1);
  const lines = [
    `余额：${overview.balanceLabel}`,
    `本月本地估算：¥${overview.month.estimatedCostCny} / ${overview.month.totalTokens} tokens / ${overview.month.recordCount} 次`,
  ];
  if (overview.settings.monthlyBudgetCny > 0) lines.push(`月度提醒预算：¥${overview.settings.monthlyBudgetCny}`);
  if (overview.settings.defaultTaskBudgetCny > 0) lines.push(`默认单任务预算：¥${overview.settings.defaultTaskBudgetCny}`);
  if (!overview.priceTable[0]?.configured) lines.push("估算单价未配置，金额仅显示为 0。");
  return lines.join("\n");
}
