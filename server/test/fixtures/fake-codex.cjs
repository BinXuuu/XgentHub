// 测试用的假 codex CLI：把每次启动时的参数和 CODEX_HOME 记进 FAKE_CODEX_LOG，
// `exec` 时按真实 `codex exec --json` 的事件格式回一句话，用来确认不同账号各自带上了自己的账号目录。
const fs = require("node:fs");

const args = process.argv.slice(2);
if (process.env.FAKE_CODEX_LOG) {
  fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, codexHome: process.env.CODEX_HOME ?? null }) + "\n");
}
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

if (args[0] === "exec") {
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk.toString("utf8")));
  process.stdin.on("end", () => {
    out({ type: "thread.started", thread_id: "fake-thread" });
    out({ type: "turn.started" });
    out({ type: "item.completed", item: { type: "agent_message", text: `来自 ${process.env.CODEX_HOME ?? "默认目录"}` } });
    out({ type: "turn.completed" });
    process.exit(0);
  });
} else if (args[0] === "login" && args[1] === "status") {
  process.stdout.write("Not logged in\n");
  process.exit(1);
} else {
  process.exit(0);
}
