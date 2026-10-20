import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("codex-usage");
const codexHome = path.join(env.root, "codex-home");
process.env.CODEX_HOME = codexHome;

const { db } = await import("../src/db/index.ts");
const { CodexAdapter } = await import("../src/adapters/codex.ts");

after(() => {
  db.close();
  env.cleanup();
});

function writeSession(relative: string, events: Array<{ timestamp: string; used: number }>, mtime: Date) {
  const file = path.join(codexHome, "sessions", relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = events.map((event) =>
    JSON.stringify({
      timestamp: event.timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          primary: { used_percent: event.used, window_minutes: 300, resets_at: 1792480193 },
          secondary: { used_percent: 50, window_minutes: 10080, resets_at: 1792896556 },
          plan_type: "plus",
        },
      },
    })
  );
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  fs.utimesSync(file, mtime, mtime);
}

test("usage uses the newest rate-limit record, even when an old session file was touched more recently", async () => {
  // 老会话：今天被 Codex 改过（修改时间最新），但里面最后一条额度记录是好几天前的。
  writeSession("2026/10/09/old.jsonl", [{ timestamp: "2026-10-11T13:04:00.000Z", used: 25 }], new Date("2026-10-20T04:29:00Z"));
  // 新会话：修改时间稍早，但额度记录是今天的。
  writeSession(
    "2026/10/16/new.jsonl",
    [
      { timestamp: "2026-10-20T03:00:00.000Z", used: 15 },
      { timestamp: "2026-10-20T03:30:00.000Z", used: 16 },
    ],
    new Date("2026-10-20T03:30:20Z")
  );

  const summary = await new CodexAdapter().getUsageSummary();
  assert.match(summary ?? "", /5 小时额度：已用 16%/);
  assert.doesNotMatch(summary ?? "", /已用 25%/);
});

test("when Codex's configured default model is no longer available, the first available model is used instead", async () => {
  const { resolveCodexModel } = await import("../src/adapters/codex.ts");
  fs.writeFileSync(
    path.join(codexHome, "models_cache.json"),
    JSON.stringify({
      models: [
        { slug: "gpt-6-sol", display_name: "GPT-6-Sol", visibility: "list", priority: 2 },
        { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", visibility: "list", priority: 1 },
        { slug: "gpt-old", display_name: "Old", visibility: "hide", priority: 0 },
      ],
    })
  );

  // 配置里写的是已经下架的模型：改用可用列表里排第一的（按 priority）。
  fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-5.5"\n');
  assert.deepEqual(resolveCodexModel(null), { model: "gpt-6.1-sol", fallbackFrom: "gpt-5.5" });

  // 配置里的默认模型还能用：不传 -m，交给 Codex 自己。
  fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-6-sol"\n');
  assert.deepEqual(resolveCodexModel(null), { model: null, fallbackFrom: null });

  // 任务明确指定了模型：用指定的。
  assert.deepEqual(resolveCodexModel("gpt-6-sol"), { model: "gpt-6-sol", fallbackFrom: null });
});
