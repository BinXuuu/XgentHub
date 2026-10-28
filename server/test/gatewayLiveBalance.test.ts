import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

// 假的 new-api：按 Key 返回不同的额度，模拟有限 / 无限 / 无效三种 Key。
const server = http.createServer((req, res) => {
  const key = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
  const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url === "/api/status") return send(200, { data: { price: 7.3, usd_exchange_rate: 7.3 } });
  if (key === "sk-bad") return send(401, { error: { message: "Invalid token", type: "new_api_error" } });
  if (req.url?.startsWith("/v1/dashboard/billing/subscription")) return send(200, { hard_limit_usd: key === "sk-unlimited" ? 100000000 : 20 });
  if (req.url?.startsWith("/v1/dashboard/billing/usage")) return send(200, { total_usage: 526.8378 });
  send(404, {});
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;

const env = setupIsolatedDb("gateway-live-balance");
process.env.TOKENEZGO_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.TOKENEZGO_API_KEY = "sk-limited";
const { db } = await import("../src/db/index.ts");
const { config } = await import("../src/config.ts");
const { getGatewayOverview, getGatewayCloudAccountStatus } = await import("../src/services/gatewayBillingService.ts");

after(() => { server.close(); db.close(); env.cleanup(); });

test("a limited key shows the real remaining balance (total minus used, usage is in cents)", async () => {
  config.tokenezgo.apiKey = "sk-limited";
  const overview = await getGatewayOverview(10, true);
  assert.equal(overview.balanceMode, "live");
  assert.equal(overview.liveBalance?.remainUsd, 14.7316);
  assert.equal(overview.balanceLabel, "剩余 $14.7316（约 ¥107.54）");
  assert.match(overview.balanceDetail ?? "", /总额度 \$20，已用 \$5\.2684（约 ¥38\.46）/);
});

test("an unlimited key shows 无限额度 plus what it has used", async () => {
  config.tokenezgo.apiKey = "sk-unlimited";
  const overview = await getGatewayOverview(10, true);
  assert.equal(overview.balanceLabel, "无限额度");
  assert.equal(overview.liveBalance?.unlimited, true);
  assert.match(overview.balanceDetail ?? "", /已用 \$5\.2684/);
  assert.equal((await getGatewayCloudAccountStatus()).balanceLabel, "当前 Key：无限额度");
});

test("a rejected key falls back to the TokenEZGO page and says why", async () => {
  config.tokenezgo.apiKey = "sk-bad";
  const overview = await getGatewayOverview(10, true);
  assert.equal(overview.balanceMode, "external");
  assert.equal(overview.balanceLabel, "查询失败，请到 TokenEZGO 查看");
  assert.equal(overview.balanceDetail, "Invalid token");
});
