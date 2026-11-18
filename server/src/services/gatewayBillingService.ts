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

// TokenEZGO 上这个 API Key 的一次真实调用（来自 /api/log/token，金额已按站点倍率扣过）。
export interface GatewayKeyCall {
  id: string;
  createdAt: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  useTimeSec: number;
  stream: boolean;
}

export interface GatewayKeyMonth {
  monthKey: string;
  count: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface GatewayLiveBalance {
  ok: boolean;
  unlimited: boolean;
  totalUsd: number | null;
  usedUsd: number | null;
  remainUsd: number | null;
  cnyPerUsd: number | null;
  keyName: string | null;
  expiresAt: string | null;
  modelLimits: string[];
  month: GatewayKeyMonth | null;
  recentCalls: GatewayKeyCall[];
  error: string | null;
  fetchedAt: string;
}

export interface GatewayOverview {
  provider: "tokenezgo";
  name: string;
  baseUrl: string;
  billingUrl: string;
  apiKeyConfigured: boolean;
  balanceMode: "live" | "external";
  balanceLabel: string;
  balanceDetail: string | null;
  balanceUrl: string;
  liveBalance: GatewayLiveBalance | null;
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

// new-api 给 API Key 用的标准额度接口：subscription 的 hard_limit_usd 是总额度（剩余 + 已用），
// usage 的 total_usage 是已用金额（单位美分）。无限额度的 Key，hard_limit_usd 固定返回 100000000。
const UNLIMITED_USD = 100_000_000;
const LIVE_BALANCE_TTL_MS = 60_000;
let liveBalanceCache: { at: number; value: GatewayLiveBalance } | null = null;

function gatewayApiBase(): string {
  return config.tokenezgo.baseUrl.replace(/\/+$/, "");
}

function gatewayOrigin(): string {
  return gatewayApiBase().replace(/\/v1$/i, "");
}

async function getJson(url: string, auth: boolean): Promise<any> {
  const res = await fetch(url, {
    headers: auth ? { authorization: `Bearer ${config.tokenezgo.apiKey}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* 下面统一报错 */ }
  if (!res.ok) throw new Error(body?.error?.message || body?.message || `HTTP ${res.status}`);
  if (!body) throw new Error("返回的不是 JSON");
  return body;
}

export async function getGatewayLiveBalance(force = false): Promise<GatewayLiveBalance | null> {
  if (!config.tokenezgo.apiKey) return null;
  if (!force && liveBalanceCache && Date.now() - liveBalanceCache.at < LIVE_BALANCE_TTL_MS) return liveBalanceCache.value;
  const base = gatewayApiBase();
  let value: GatewayLiveBalance;
  try {
    // 额度两项是必需的；Key 详情和调用记录是 new-api 后加的接口，查不到时只少显示一些内容。
    const [subscription, usage, status, tokenUsage, logs] = await Promise.all([
      getJson(`${base}/dashboard/billing/subscription`, true),
      getJson(`${base}/dashboard/billing/usage`, true),
      getJson(`${gatewayOrigin()}/api/status`, false).catch(() => null),
      getJson(`${gatewayOrigin()}/api/usage/token/`, true).catch(() => null),
      getJson(`${gatewayOrigin()}/api/log/token`, true).catch(() => null),
    ]);
    const total = Number(subscription?.hard_limit_usd);
    const usedCents = Number(usage?.total_usage);
    if (!Number.isFinite(total)) throw new Error("额度接口没有返回 hard_limit_usd");
    const unlimited = total >= UNLIMITED_USD;
    const usedUsd = Number.isFinite(usedCents) ? roundMoney(usedCents / 100) : null;
    const rate = Number(status?.data?.price) || Number(status?.data?.usd_exchange_rate) || 0;
    const quotaPerUnit = Number(status?.data?.quota_per_unit) || DEFAULT_QUOTA_PER_UNIT;
    const keyInfo = tokenUsage?.data;
    const calls = Array.isArray(logs?.data) ? parseKeyCalls(logs.data, quotaPerUnit) : null;
    value = {
      ok: true,
      unlimited,
      totalUsd: unlimited ? null : roundMoney(total),
      usedUsd,
      remainUsd: unlimited || usedUsd === null ? null : roundMoney(Math.max(0, total - usedUsd)),
      cnyPerUsd: rate > 0 ? rate : null,
      keyName: typeof keyInfo?.name === "string" && keyInfo.name ? keyInfo.name : null,
      expiresAt: Number(keyInfo?.expires_at) > 0 ? new Date(Number(keyInfo.expires_at) * 1000).toISOString() : null,
      modelLimits: keyInfo?.model_limits_enabled && keyInfo.model_limits && typeof keyInfo.model_limits === "object" ? Object.keys(keyInfo.model_limits) : [],
      month: calls ? summarizeKeyMonth(calls) : null,
      recentCalls: calls ? calls.slice(0, 10) : [],
      error: null,
      fetchedAt: now(),
    };
  } catch (err) {
    value = {
      ok: false, unlimited: false, totalUsd: null, usedUsd: null, remainUsd: null, cnyPerUsd: null,
      keyName: null, expiresAt: null, modelLimits: [], month: null, recentCalls: [],
      error: err instanceof Error ? err.message : String(err), fetchedAt: now(),
    };
  }
  liveBalanceCache = { at: Date.now(), value };
  return value;
}

// new-api 的消费日志里 quota 是内部额度单位，除以 quota_per_unit 才是美元。
const DEFAULT_QUOTA_PER_UNIT = 500_000;

function parseKeyCalls(rows: any[], quotaPerUnit: number): GatewayKeyCall[] {
  return rows
    .filter((row) => row && Number(row.type) === 2) // 2 = 消费；充值、管理等记录不算
    .map((row) => ({
      id: String(row.request_id || row.id),
      createdAt: new Date(Number(row.created_at) * 1000).toISOString(),
      model: String(row.model_name ?? ""),
      promptTokens: Number(row.prompt_tokens) || 0,
      completionTokens: Number(row.completion_tokens) || 0,
      costUsd: Math.round(((Number(row.quota) || 0) / quotaPerUnit) * 1e8) / 1e8, // 单次可能只有几百万分之一美元，不能按 4 位小数抹成 0
      useTimeSec: Number(row.use_time) || 0,
      stream: Boolean(row.is_stream),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function summarizeKeyMonth(calls: GatewayKeyCall[]): GatewayKeyMonth {
  const key = monthKey();
  const inMonth = calls.filter((call) => monthKey(new Date(call.createdAt)) === key);
  return {
    monthKey: key,
    count: inMonth.length,
    promptTokens: inMonth.reduce((sum, call) => sum + call.promptTokens, 0),
    completionTokens: inMonth.reduce((sum, call) => sum + call.completionTokens, 0),
    costUsd: roundMoney(inMonth.reduce((sum, call) => sum + call.costUsd, 0)),
  };
}

function usdText(usd: number, rate: number | null): string {
  if (usd > 0 && usd < 0.0001) return "<$0.0001";
  const main = `$${usd.toFixed(usd >= 100 ? 2 : 4).replace(/\.?0+$/, "") || "0"}`;
  return rate ? `${main}（约 ¥${(usd * rate).toFixed(2)}）` : main;
}

function describeLiveBalance(live: GatewayLiveBalance | null): { mode: "live" | "external"; label: string; detail: string | null } {
  if (!live) return { mode: "external", label: "填好 API Key 后显示", detail: null };
  if (!live.ok) return { mode: "external", label: "查询失败，请到 TokenEZGO 查看", detail: live.error };
  const used = live.usedUsd === null ? null : `已用 ${usdText(live.usedUsd, live.cnyPerUsd)}`;
  if (live.unlimited) return { mode: "live", label: "无限额度", detail: ["这个 Key 在 TokenEZGO 设置为无限额度", used].filter(Boolean).join("，") };
  const remain = live.remainUsd ?? 0;
  return {
    mode: "live",
    label: `剩余 ${usdText(remain, live.cnyPerUsd)}`,
    detail: [`总额度 ${usdText(live.totalUsd ?? 0, null)}`, used].filter(Boolean).join("，"),
  };
}

export async function getGatewayOverview(limit = 10, forceBalance = false): Promise<GatewayOverview> {
  const live = await getGatewayLiveBalance(forceBalance);
  const balance = describeLiveBalance(live);
  const settings = getGatewayBillingSettings();
  const records = listGatewayUsageRecords();
  const month = summarizeGatewayUsage(records);
  const priceConfigured =
    settings.inputPriceCnyPer1K > 0 ||
    settings.outputPriceCnyPer1K > 0 ||
    settings.modelPriceRules.some((rule) => rule.enabled && (rule.inputPriceCnyPer1K > 0 || rule.outputPriceCnyPer1K > 0));
  const notices = [
    priceConfigured ? "已配置本地估算单价，预算提醒按这里的单价估算花费。" : "尚未配置估算单价，预算提醒按 0 元计算，不会拦截任务。",
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
    balanceMode: balance.mode,
    balanceLabel: balance.label,
    balanceDetail: balance.detail,
    balanceUrl: "https://tokenezgo.com",
    liveBalance: live,
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

export async function getGatewayUsageSummaryText(): Promise<string | null> {
  const overview = await getGatewayOverview(1, true);
  const live = overview.liveBalance;
  const lines = [`余额：${overview.balanceLabel}`];
  if (live?.ok && live.usedUsd !== null) lines.push(`已用：${usdText(live.usedUsd, live.cnyPerUsd)}`);
  if (live?.ok && live.month) lines.push(`本月消费：${usdText(live.month.costUsd, live.cnyPerUsd)} / ${live.month.count} 次`);
  if (!live?.ok) lines.push("账户余额和账单请到 TokenEZGO 查看");
  if (overview.settings.monthlyBudgetCny > 0) lines.push(`月度提醒预算：¥${overview.settings.monthlyBudgetCny}`);
  if (overview.settings.defaultTaskBudgetCny > 0) lines.push(`默认单任务预算：¥${overview.settings.defaultTaskBudgetCny}`);
  return lines.join("\n");
}
