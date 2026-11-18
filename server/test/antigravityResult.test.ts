import test from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

setupIsolatedDb("antigravity-result");
const { createStreamHandler } = await import("../src/adapters/antigravity.ts");

function fakeCtx() {
  const state = { messages: [] as string[], status: null as string | null, logs: [] as string[] };
  const ctx: any = {
    setSessionKey: () => undefined,
    reportModel: () => undefined,
    reportUsage: () => undefined,
    terminal: () => undefined,
    log: (line: string) => state.logs.push(line),
    agentMessage: (text: string) => state.messages.push(text),
    setStatus: (status: string) => (state.status = status),
  };
  return { ctx, state };
}

const ERROR = "API error (attempt 1): request failed: stream idle timeout (5m0s): context deadline exceeded";
const line = (value: object) => JSON.stringify(value);

test("agy reports an error but this turn already answered: keep the answer, mark for review, explain", () => {
  const { ctx, state } = fakeCtx();
  const handler = createStreamHandler(ctx);
  handler.handleLine(line({ event: "init", conversation_id: "c1", init: { model: "gemini" } }));
  handler.handleLine(line({ event: "step_update", step_update: { text_delta: "8 款方案都放在 ceshi 文件夹里了，" } }));
  handler.handleLine(line({ event: "step_update", step_update: { text_delta: "你最中意哪一个编号？" } }));
  handler.handleLine(line({ event: "result", result: { status: "ERROR", error: ERROR, conversation_id: "c1" } }));
  assert.equal(handler.finish(0, ""), "review");
  assert.equal(state.status, "review");
  assert.equal(state.messages.length, 1);
  assert.match(state.messages[0], /^8 款方案都放在 ceshi 文件夹里了，你最中意哪一个编号？/);
  assert.match(state.messages[0], /Antigravity 最后报告了一个错误：API error \(attempt 1\)/);
  assert.ok(state.logs.some((l) => l.includes("按待复核处理")));
});

test("agy reports an error and produced nothing this turn: still a failure", () => {
  const { ctx, state } = fakeCtx();
  const handler = createStreamHandler(ctx);
  handler.handleLine(line({ event: "result", result: { status: "ERROR", error: ERROR } }));
  assert.equal(handler.finish(1, ""), "failed");
  assert.equal(state.status, "failed");
  assert.match(state.messages[0], /^Antigravity 调用失败：\nAPI error/);
});

test("a normal success is unchanged", () => {
  const { ctx, state } = fakeCtx();
  const handler = createStreamHandler(ctx);
  handler.handleLine(line({ event: "step_update", step_update: { text_delta: "好了" } }));
  handler.handleLine(line({ event: "result", result: { status: "SUCCESS", response: "好了" } }));
  assert.equal(handler.finish(0, ""), "review");
  assert.deepEqual(state.messages, ["好了"]);
});
