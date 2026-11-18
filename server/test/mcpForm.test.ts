import test from "node:test";
import assert from "node:assert/strict";
import { formatArgsText, formatCommandLine, parseArgsText, parseMcpImport } from "../../web/src/utils/mcpForm.ts";

test("args: one per line or space separated, quotes keep paths with spaces whole, backslashes stay", () => {
  assert.deepEqual(parseArgsText("-m cad_mcp.server"), ["-m", "cad_mcp.server"]);
  assert.deepEqual(parseArgsText("-m\ncad_mcp.server\n"), ["-m", "cad_mcp.server"]);
  assert.deepEqual(parseArgsText('"D:\\My Tools\\bridge.js" --port 1\r\nD:\\工具\\运维桥接\\dist\\mcp-stdio.js'), [
    "D:\\My Tools\\bridge.js",
    "--port",
    "1",
    "D:\\工具\\运维桥接\\dist\\mcp-stdio.js",
  ]);
  assert.deepEqual(parseArgsText('--name ""'), ["--name", ""]);
});

test("args: editing an entry and saving it again does not change it", () => {
  const args = ["D:\\My Tools\\bridge.js", "-m", "x y", "", "C:\\Program Files\\nodejs\\"];
  assert.deepEqual(parseArgsText(formatArgsText(args)), args);
});

test("import: a single entry like the config file a bridge program generates", () => {
  const [server, ...rest] = parseMcpImport(
    JSON.stringify({
      name: "ops-bridge",
      transport: "stdio",
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["D:\\工具\\运维桥接\\dist\\mcp-stdio.js"],
      env: { OPS_CORE_URL: "http://127.0.0.1:4318", OPS_CORE_TOKEN_FILE: "D:\\x\\token" },
      enabled: true,
    })
  );
  assert.equal(rest.length, 0);
  assert.deepEqual(server, {
    name: "ops-bridge",
    transport: "stdio",
    command: "C:\\Program Files\\nodejs\\node.exe",
    args: ["D:\\工具\\运维桥接\\dist\\mcp-stdio.js"],
    env: { OPS_CORE_URL: "http://127.0.0.1:4318", OPS_CORE_TOKEN_FILE: "D:\\x\\token" },
    url: null,
    headers: {},
  });
});

test("import: the standard mcpServers wrapper with stdio and http entries", () => {
  const servers = parseMcpImport(
    JSON.stringify({ mcpServers: { cad: { command: "python", args: ["-m", "cad"], env: { A: 1 } }, docs: { type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer t" } } } })
  );
  assert.deepEqual(
    servers.map((s) => [s.name, s.transport, s.command, s.args, s.env, s.url, s.headers]),
    [
      ["cad", "stdio", "python", ["-m", "cad"], { A: "1" }, null, {}],
      ["docs", "http", null, [], {}, "https://x/mcp", { Authorization: "Bearer t" }],
    ]
  );
});

test("import: clear errors for bad input", () => {
  assert.throws(() => parseMcpImport("{oops"), /不是有效的 JSON/);
  assert.throws(() => parseMcpImport(JSON.stringify({ mcpServers: { a: { args: [] } } })), /「a」缺少 command/);
  assert.throws(() => parseMcpImport(JSON.stringify({ mcpServers: {} })), /没有找到/);
});

test("the one-line command shown in the MCP list quotes parts with spaces", () => {
  assert.equal(
    formatCommandLine("C:\\Program Files\\nodejs\\node.exe", ["D:\\Agent\\ops agent\\mcp.js", "--port", "4318"]),
    '"C:\\Program Files\\nodejs\\node.exe" "D:\\Agent\\ops agent\\mcp.js" --port 4318'
  );
  assert.equal(formatCommandLine("npx", ["-y", "server"]), "npx -y server");
});
