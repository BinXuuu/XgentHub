// 测试用的假 claude CLI：按真实 claude（2.1.x）在 --input-format stream-json --permission-prompt-tool stdio 下的
// 协议说话（协议是 2026-10-13 对着真 claude.exe 抓下来的）：收到用户消息 → 要跑一条会改东西的命令 →
// 发 control_request(can_use_tool) 停下来等 → 按宿主回的 allow/deny 继续 → 发 result。
// 每次启动把收到的参数写进 FAKE_CLAUDE_ARGS_FILE，方便测试检查。
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_ARGS_FILE) fs.appendFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, JSON.stringify(args) + "\n");
// 账号测试用：记下这次启动带的账号目录和 Key 相关环境变量。
if (process.env.FAKE_CLAUDE_ENV_FILE) {
  const pick = ["CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"];
  fs.appendFileSync(process.env.FAKE_CLAUDE_ENV_FILE, JSON.stringify(Object.fromEntries(pick.map((key) => [key, process.env[key] ?? null]))) + "\n");
}
// CodeBuddy 不带 --permission-prompt-tool，只要是 stream-json 输入就会在 stdout 发权限询问（FAKE_CLI_ASK_ON_STREAM_INPUT=1 模拟它）。
const interactive = args.includes("--permission-prompt-tool") || (process.env.FAKE_CLI_ASK_ON_STREAM_INPUT === "1" && args.includes("--input-format"));
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const REQUEST_ID = "req-1";
const TOOL_INPUT = { command: "mkdir out-dir", description: "Create out-dir directory" };

function finish(text) {
  out({ type: "assistant", message: { content: [{ type: "text", text }] } });
  out({ type: "result", subtype: "success", is_error: false, result: text, session_id: "fake-session" });
}

function runTool() {
  fs.mkdirSync(path.join(process.cwd(), "out-dir"), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), "out-dir", "result.txt"), "hello\n");
  finish("已建好 out-dir");
}

// 模拟没登录的 CodeBuddy：一上来就回这句话并以错误结束。
if (process.env.FAKE_CLI_NOT_LOGGED_IN === "1") {
  const text = "Authentication required. Please use /login command to sign in to your account";
  if (args.includes("json") && !args.includes("stream-json")) process.stdout.write(JSON.stringify([{ type: "message", role: "user" }, { type: "result", subtype: "error_during_execution", is_error: true, result: text }]));
  else {
    out({ type: "assistant", message: { content: [{ type: "text", text }] } });
    out({ type: "result", subtype: "error_during_execution", is_error: true, result: text, session_id: "fake-session" });
  }
  process.exit(0);
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
      out({ type: "system", subtype: "init", session_id: "fake-session", model: "claude-fake-default" });
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
      // FAKE_CLI_ANSWER_STYLE=codebuddy：只认 CodeBuddy 的 { allowed, reason }，收到 Claude 格式一律当拒绝（真 codebuddy 就是这样）。
      const allowed = process.env.FAKE_CLI_ANSWER_STYLE === "codebuddy" ? answer.allowed === true : answer.behavior === "allow";
      if (allowed) runTool();
      else finish(`被拒绝了：${(process.env.FAKE_CLI_ANSWER_STYLE === "codebuddy" ? answer.reason : answer.message) ?? "Permission denied by SDK"}`);
    }
  }
});
process.stdin.on("end", () => {
  // 非交互模式（完全访问 / 计划模式）：整段 stdin 就是 prompt，直接干完。
  if (!interactive) runTool();
  process.exit(0);
});
