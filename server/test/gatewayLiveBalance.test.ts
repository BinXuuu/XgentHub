import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

// 本月和上个月各一条消费，再加一条非消费记录（type 1 充值），检查只算本月消费。
const nowSec = Math.floor(Date.now() / 1000);
const lastMonth = new Date();
lastMonth.setDate(1);
lastMonth.setMonth(lastMonth.getMonth() - 1);
const logRows = [
  { id: 1, type: 2, created_at: Math.floor(lastMonth.getTime() / 1000), model_name: "deepseek-chat", prompt_tokens: 100, completion_tokens: 10, quota: 250000, use_time: 2, is_stream: true, request_id: "old" },
  { id: 2, type: 1, created_at: nowSec - 30, model_name: "", prompt_tokens: 0, completion_tokens: 0, quota: 5000000, use_time: 0, is_stream: false, request_id: "topup" },
  { id: 3, type: 2, created_at: nowSec - 60, model_name: "claude-opus-4-8", prompt_tokens: 1200, completion_tokens: 300, quota: 1000000, use_time: 5, is_stream: true, request_id: "new" },
];

// 假的 new-api：按 Key 返回不同的额度，模拟有限 / 无限 / 无效三种 Key。
const server = http.createServer((req, res) => {
  const key = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
  const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url === "/api/status") return send(200, { data: { price: 7.3, usd_exchange_rate: 7.3, quota_per_unit: 500000 } });
  if (key === "sk-bad") return send(401, { error: { message: "Invalid token", type: "new_api_error" } });
  if (req.url?.startsWith("/v1/dashboard/billing/subscription")) return send(200, { hard_limit_usd: key === "sk-unlimited" ? 100000000 : 20 });
  if (req.url?.startsWith("/v1/dashboard/billing/usage")) return send(200, { total_usage: 526.8378 });
  if (req.url === "/api/usage/token/") {
    return send(200, { code: true, data: { name: "我的电脑", expires_at: key === "sk-limited" ? 1893456000 : 0, model_limits_enabled: key === "sk-limited", model_limits: { "gpt-4o-mini": true, "deepseek-chat": true }, unlimited_quota: key === "sk-unlimited" } });
  }
  if (req.url === "/api/log/token") return send(200, { success: true, data: logRows });
  send(404, {});
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;

const env = setupIsolatedDb("gateway-live-balance");
process.env.TOKENEZGO_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.TOKENEZGO_API_KEY = "sk-limited";
const { db } = await import("../src/db/index.ts");
const { config } = await import("../src/config.ts");
const { getGatewayOverview, getGatewayUsageSummaryText } = await import("../src/services/gatewayBillingService.ts");

after(() => { server.close(); db.close(); env.cleanup(); });

test("a limited key shows the real remaining balance (total minus used, usage is in cents)", async () => {
  config.tokenezgo.apiKey = "sk-limited";
  const overview = await getGatewayOverview(10, true);
  assert.equal(overview.balanceMode, "live");
  assert.equal(overview.liveBalance?.remainUsd, 14.7316);
  assert.equal(overview.balanceLabel, "剩余 $14.7316（约 ¥107.54）");
  assert.match(overview.balanceDetail ?? "", /总额度 \$20，已用 \$5\.2684（约 ¥38\.46）/);
  assert.equal(overview.liveBalance?.keyName, "我的电脑");
  assert.equal(overview.liveBalance?.expiresAt, "2030-01-01T00:00:00.000Z");
  assert.deepEqual(overview.liveBalance?.modelLimits, ["gpt-4o-mini", "deepseek-chat"]);
});

test("call records come from the key's log: only consumption rows, newest first, this month summed", async () => {
  config.tokenezgo.apiKey = "sk-limited";
  const live = (await getGatewayOverview(10, true)).liveBalance!;
  assert.deepEqual(live.recentCalls.map((call) => call.id), ["new", "old"]);
  assert.equal(live.recentCalls[0].costUsd, 2); // 1000000 / 500000
  assert.deepEqual(
    { count: live.month?.count, cost: live.month?.costUsd, tokens: (live.month?.promptTokens ?? 0) + (live.month?.completionTokens ?? 0) },
    { count: 1, cost: 2, tokens: 1500 },
  );
  const summary = (await getGatewayUsageSummaryText())!;
  assert.match(summary, /本月消费：\$2（约 ¥14\.60） \/ 1 次/);
});

test("an unlimited key shows 无限额度 plus what it has used", async () => {
  config.tokenezgo.apiKey = "sk-unlimited";
  const overview = await getGatewayOverview(10, true);
  assert.equal(overview.balanceLabel, "无限额度");
  assert.equal(overview.liveBalance?.unlimited, true);
  assert.equal(overview.liveBalance?.expiresAt, null);
  assert.deepEqual(overview.liveBalance?.modelLimits, []);
  assert.match(overview.balanceDetail ?? "", /已用 \$5\.2684/);
});

test("a rejected key falls back to the TokenEZGO page and says why", async () => {
  config.tokenezgo.apiKey = "sk-bad";
  const overview = await getGatewayOverview(10, true);
  assert.equal(overview.balanceMode, "external");
  assert.equal(overview.balanceLabel, "查询失败，请到 TokenEZGO 查看");
  assert.equal(overview.balanceDetail, "Invalid token");
  assert.deepEqual(overview.liveBalance?.recentCalls, []);
  assert.match((await getGatewayUsageSummaryText())!, /账户余额和账单请到 TokenEZGO 查看/);
});
