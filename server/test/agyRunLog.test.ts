import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { explainAgyLogLine, isAgyRunLogFor, watchAgyRunLog } from "../src/adapters/agyRunLog.ts";
import { describeActionLine, summarizeLiveActivity } from "../../web/src/utils/liveActivity.ts";

// agy 不出声时只写自己的日志；下面的行都是 2026-11-17 从本机 ~/.gemini/antigravity-cli/log 里原样抄的。

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-agy-log-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("retry lines become plain sentences", () => {
  assert.equal(
    explainAgyLogLine(
      "I1117 20:45:25.424938     136 run.go:317] Run: attempt 1 failed (request failed: stream idle timeout (10m0s): context deadline exceeded), retrying in 4s"
    ),
    "第 1 次请求模型没成功：模型 10 分钟没有回应，4 秒后自动重试"
  );
  assert.equal(
    explainAgyLogLine(
      "I1117 20:55:29.477003     136 run.go:317] Run: attempt 2 failed (request failed: stream idle timeout (10m0s): context deadline exceeded), retrying in 6.889113149s"
    ),
    "第 2 次请求模型没成功：模型 10 分钟没有回应，7 秒后自动重试"
  );
  assert.equal(
    explainAgyLogLine(
      'I1117 08:20:01.000000     136 run.go:317] Run: attempt 1 failed (request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": EOF), retrying in 4s'
    ),
    "第 1 次请求模型没成功：连模型服务器的网络断了，4 秒后自动重试"
  );
  assert.equal(
    explainAgyLogLine(
      "I1110 13:00:00.000000     136 run.go:395] Run: attempt 3 failed (RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 26h28m33s.), retrying in 9.824935496s"
    ),
    "第 3 次请求模型没成功：这个账号的额度用完了（约 26 小时 28 分后恢复），10 秒后自动重试"
  );
  assert.equal(
    explainAgyLogLine(
      "I1110 13:00:00.000000     136 run.go:317] Run: attempt 5 failed (UNAVAILABLE (code 503): No capacity available for model gemini-4-argon-medium on the server), retrying in 24.974560081s"
    ),
    "第 5 次请求模型没成功：模型那边太忙，暂时没有空闲算力，25 秒后自动重试"
  );
  assert.equal(explainAgyLogLine("I1117 20:59:17.506435    2785 http_helpers.go:709] URL: https://x/v1internal:fetchAvailableModels"), null);
});

const startLine = (bytes: number, conversation: string) =>
  `I1117 20:35:18.003129       1 printmode.go:208] Print mode: starting (promptLength=${bytes}, model="gemini-4-argon-medium", conversationID="${conversation}")`;

test("a log belongs to this run only when prompt bytes, conversation and model all match", () => {
  const prompt = "用户任务：\n帮我给 小鹿咖啡 制作logo"; // 中文按 UTF-8 字节算，不是字数
  const bytes = Buffer.byteLength(prompt, "utf8");
  const me = { prompt, conversationId: "conv-aaaa", model: "gemini-4-argon-medium" };
  assert.equal(isAgyRunLogFor(startLine(bytes, "conv-aaaa"), me), true);
  assert.equal(isAgyRunLogFor(startLine(prompt.length, "conv-aaaa"), me), false);
  assert.equal(isAgyRunLogFor(startLine(bytes, "conv-bbbb"), me), false, "another task running at the same time");
  assert.equal(isAgyRunLogFor(startLine(bytes, ""), { ...me, conversationId: null }), true, "new conversation");
  assert.equal(isAgyRunLogFor(startLine(bytes, "conv-aaaa"), { ...me, model: "gemini-3-flash" }), false);
  assert.equal(isAgyRunLogFor("Print mode: running slash command /credits", me), false);
});

test("the watcher picks its own new log among several and reports retries as they are written", async () => {
  const logDir = path.join(root, "log");
  fs.mkdirSync(logDir);
  const retry = (n: number) =>
    `I1117 20:45:25.424938     136 run.go:317] Run: attempt ${n} failed (request failed: stream idle timeout (10m0s): context deadline exceeded), retrying in 4s`;
  // 启动前就有的旧日志（里面也有重试）不算
  const prompt = "做一个 logo";
  const bytes = Buffer.byteLength(prompt, "utf8");
  fs.writeFileSync(path.join(logDir, "cli-20261117_200000.log"), `${startLine(bytes, "c1")}\n${retry(9)}\n`);

  const notices: string[] = [];
  const stop = watchAgyRunLog(logDir, { prompt, conversationId: "c1", model: "gemini-4-argon-medium" }, (n) => notices.push(n), 20);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // 同时启动的另一个任务（别的对话）、查额度用的 agy、还没写到开头那行的日志
  fs.writeFileSync(path.join(logDir, "cli-20261117_203514.log"), `${startLine(bytes, "c2")}\n${retry(7)}\n`);
  fs.writeFileSync(path.join(logDir, "cli-20261117_203516.log"), "I1117 x printmode.go:331] Print mode: running slash command /credits\n");
  const own = path.join(logDir, "cli-20261117_203515.log");
  fs.writeFileSync(own, "I1117 20:35:15.343033       1 resolver.go:85] Model ID gemini-4-argon-medium not in local config\n");
  await wait(80);
  assert.deepEqual(notices, []);

  fs.appendFileSync(own, `${startLine(bytes, "c1")}\n${retry(1)}\n`);
  await wait(80);
  assert.deepEqual(notices, ["第 1 次请求模型没成功：模型 10 分钟没有回应，4 秒后自动重试"]);

  // 半行先写进来：等写完整了才报
  fs.appendFileSync(own, retry(2).slice(0, 40));
  await wait(80);
  assert.equal(notices.length, 1);
  fs.appendFileSync(own, `${retry(2).slice(40)}\n`);
  stop(); // 进程结束：最后写的也读出来
  assert.equal(notices.length, 2);
  assert.match(notices[1]!, /^第 2 次/);
});

test("the notice shows up as a highlighted step in 'what it is doing'", () => {
  const line = "$ [antigravity:notice] 第 1 次请求模型没成功：模型 10 分钟没有回应，4 秒后自动重试";
  assert.equal(describeActionLine(line), "第 1 次请求模型没成功：模型 10 分钟没有回应，4 秒后自动重试");
  const at = (s: number) => new Date(Date.UTC(2026, 10, 17, 12, 35, s)).toISOString();
  const activity = summarizeLiveActivity(
    [
      { type: "terminal", payload: { chunk: '$ agy -p "logo"\n' }, createdAt: at(0) },
      { type: "terminal", payload: { chunk: `\n${line}\n` }, createdAt: at(30) },
    ],
    0
  );
  assert.deepEqual(activity.steps, [{ at: Date.parse(at(30)), label: describeActionLine(line), warn: true }]);
});
