import test from "node:test";
import assert from "node:assert/strict";
import { describeActionLine, formatDuration, summarizeLiveActivity } from "../../web/src/utils/liveActivity.ts";

// 对话页运行中的「正在做什么」：终端输出 → 人看得懂的几步（格式照各 adapter 的 ctx.terminal）。

const at = (s: number) => new Date(Date.UTC(2026, 10, 17, 8, 0, s)).toISOString();
const term = (s: number, chunk: string) => ({ type: "terminal", payload: { chunk }, createdAt: at(s) });

test("each agent's action lines become plain steps; the launch line is not a step", () => {
  assert.equal(describeActionLine('$ [antigravity:write_file] {"Path":"C:\\\\work\\\\logo.svg"}'), "写入 logo.svg");
  assert.equal(describeActionLine('$ [antigravity:run_command] {"CommandLine":"npm run build"}'), "运行命令：npm run build");
  assert.equal(describeActionLine('$ [antigravity:search_web] {"query":"小鹿咖啡"}'), "上网搜索 小鹿咖啡");
  assert.equal(describeActionLine('$ [tool_use] Edit {"file_path":"/repo/src/a.ts","old_string":"x"}'), "修改 a.ts");
  assert.equal(describeActionLine('$ [tool_use] Bash {"command":"npm test"}'), "运行命令：npm test");
  assert.equal(describeActionLine('$ [read_file] {"path":"src/b.ts"}'), "读取 b.ts");
  assert.equal(describeActionLine("$ npm install left-pad"), "运行命令：npm install left-pad");
  assert.equal(describeActionLine('$ [antigravity:something_new] {"x":1}'), "调用 something_new");
  // 启动 Agent 那一行（可能是完整路径）不算一步
  for (const launch of ['$ agy --output-format stream-json -p "hi"', '$ "C:\\Program Files\\Claude\\claude.exe" -p', "$ C:\\x\\agy.cmd --add-dir C:\\w", "$ codex exec --json < prompt", "$ POST https://api.x/v1 (model=a)"]) {
    assert.equal(describeActionLine(launch), null, launch);
  }
});

test("a run: steps in order, start/end of the same tool counted once, latest written text kept", () => {
  const events = [
    term(0, "$ agy --output-format stream-json -p \"logo\"\n"),
    term(5, '\n$ [antigravity:read_file] {"Path":"C:\\\\w\\\\brief.md"}\n'),
    term(6, '\n$ [antigravity:read_file] {"Path":"C:\\\\w\\\\brief.md"}\n12 lines\n'),
    term(20, '\n$ [antigravity:write_file] {"Path":"C:\\\\w\\\\logo-1.svg"}\n'),
    term(30, "已为「小鹿咖啡」"),
    term(31, "做好两款 logo"),
  ];
  const a = summarizeLiveActivity(events, Date.parse(at(0)));
  assert.equal(a.startedAt, Date.parse(at(0)));
  assert.deepEqual(a.steps.map((s) => s.label), ["读取 brief.md", "写入 logo-1.svg"]);
  assert.equal(a.lastAt, Date.parse(at(31)));
  assert.equal(a.latestOutput, "已为「小鹿咖啡」做好两款 logo");
});

test("output before this run is ignored, and a new launch line starts over (queued message)", () => {
  const events = [
    term(0, '\n$ [antigravity:write_file] {"Path":"old.svg"}\n'),
    term(10, "$ agy -p \"first\"\n"),
    term(12, '\n$ [antigravity:read_file] {"Path":"a.md"}\n'),
    term(40, "$ agy -p \"second\"\n"),
    term(42, '\n$ [antigravity:write_file] {"Path":"b.svg"}\n'),
  ];
  const a = summarizeLiveActivity(events, Date.parse(at(5)));
  assert.equal(a.startedAt, Date.parse(at(40)));
  assert.deepEqual(a.steps.map((s) => s.label), ["写入 b.svg"]);
});

test("no output yet, and only the latest steps are kept", () => {
  assert.deepEqual(summarizeLiveActivity([], 0), { startedAt: null, steps: [], lastAt: null, latestOutput: null });
  const many = Array.from({ length: 9 }, (_, i) => term(i, `$ [read_file] {"path":"f${i}.ts"}\n`));
  assert.deepEqual(summarizeLiveActivity(many, 0, 3).steps.map((s) => s.label), ["读取 f6.ts", "读取 f7.ts", "读取 f8.ts"]);
});

test("durations read naturally", () => {
  assert.equal(formatDuration(4_000), "4 秒");
  assert.equal(formatDuration(192_000), "3 分 12 秒");
  assert.equal(formatDuration(3_720_000), "1 小时 2 分");
});
