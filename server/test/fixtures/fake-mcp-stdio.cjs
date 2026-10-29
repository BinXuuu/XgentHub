// 测试用的假 MCP stdio server：一行一条 JSON-RPC。启动先往 stdout 打一行日志（真实服务常这么干），
// FAKE_MCP_MODE=crash 直接退出，=silent 只读不答，其余正常回 initialize / tools/list（两页）。
const mode = process.env.FAKE_MCP_MODE ?? "ok";
if (mode === "crash") {
  process.stderr.write("boom: missing config\n");
  process.exit(3);
}
process.stdout.write("starting fake server...\n");
let buffer = "";
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const msg = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (mode === "silent" || msg.id === undefined) continue;
    if (msg.method === "initialize") {
      out({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "9.9" } } });
    } else if (msg.method === "tools/list") {
      const page2 = msg.params?.cursor === "p2";
      out({
        jsonrpc: "2.0",
        id: msg.id,
        result: page2 ? { tools: [{ name: "gamma" }] } : { tools: [{ name: "alpha" }, { name: process.argv[2] ?? "beta" }], nextCursor: "p2" },
      });
    } else {
      out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
