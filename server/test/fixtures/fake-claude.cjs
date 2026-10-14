// 测试用的假 claude CLI：按真实 claude（2.1.x）在 --input-format stream-json --permission-prompt-tool stdio 下的
// 协议说话（协议是 2026-10-13 对着真 claude.exe 抓下来的）：收到用户消息 → 要跑一条会改东西的命令 →
// 发 control_request(can_use_tool) 停下来等 → 按宿主回的 allow/deny 继续 → 发 result。
// 每次启动把收到的参数写进 FAKE_CLAUDE_ARGS_FILE，方便测试检查。
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_ARGS_FILE) fs.appendFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, JSON.stringify(args) + "\n");
const interactive = args.includes("--permission-prompt-tool");
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const REQUEST_ID = "req-1";
const TOOL_INPUT = { command: "mkdir out-dir", description: "Create out-dir directory" };

function finish(text) {
  out({ type: "assistant", message: { content: [{ type: "text", text }] } });
  out({ type: "result", subtype: "success", is_error: false, result: text, session_id: "fake-session" });
}

function runTool() {
  fs.mkdirSync(path.join(process.cwd(), "out-dir"), { recursive: true });
  finish("已建好 out-dir");
}

let buffer = "";
let started = false;
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  if (!interactive) return;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.type === "user" && !started) {
      started = true;
      out({ type: "system", subtype: "init", session_id: "fake-session" });
      out({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "PowerShell", input: TOOL_INPUT }] } });
      out({
        type: "control_request",
        request_id: REQUEST_ID,
        request: {
          subtype: "can_use_tool",
          tool_name: "PowerShell",
          display_name: "PowerShell",
          input: TOOL_INPUT,
          description: "Create out-dir directory",
          blocked_path: path.join(process.cwd(), "out-dir"),
          tool_use_id: "toolu_1",
        },
      });
    } else if (msg.type === "control_response" && msg.response?.request_id === REQUEST_ID) {
      const answer = msg.response.response;
      if (answer.behavior === "allow") runTool();
      else finish(`被拒绝了：${answer.message}`);
    }
  }
});
process.stdin.on("end", () => {
  // 非交互模式（完全访问 / 计划模式）：整段 stdin 就是 prompt，直接干完。
  if (!interactive) runTool();
  process.exit(0);
});
