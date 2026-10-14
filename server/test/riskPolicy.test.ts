import test from "node:test";
import assert from "node:assert/strict";
import { scanRisk, shouldGate } from "../src/adapters/riskPolicy.ts";

test("scanRisk classifies destructive commands and sensitive paths", () => {
  assert.deepEqual(scanRisk("please run rm -rf node_modules"), {
    riskLevel: "high",
    reason: "包含批量/强制删除类命令",
  });
  assert.deepEqual(scanRisk("git push origin main"), {
    riskLevel: "medium",
    reason: "包含 git push（会推送到远端仓库）",
  });
  assert.deepEqual(scanRisk("cat .env"), {
    riskLevel: "medium",
    reason: "涉及密钥/凭证相关文件",
  });
  assert.equal(scanRisk("read src/index.ts and summarize it"), null);
});

test("shouldGate follows supervised, auto, and full permission modes", () => {
  assert.equal(shouldGate("medium", "supervised"), true);
  assert.equal(shouldGate("high", "supervised"), true);
  assert.equal(shouldGate("medium", "auto"), false);
  assert.equal(shouldGate("high", "auto"), true);
  assert.equal(shouldGate("high", "full"), false);
});
