import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("chat-context");
const { db } = await import("../src/db/index.ts");
const knowledgeService = await import("../src/services/knowledgeService.ts");
const { formatLibraryContext } = await import("../src/services/resourceLibraryService.ts");
const { buildChatPrompt } = await import("../src/services/chatService.ts");

after(() => {
  db.close();
  env.cleanup();
});

test("chat prompt is unchanged when nothing is selected", () => {
  assert.equal(buildChatPrompt({ skillIds: [], toolIds: [], knowledgeIds: [] }, "你好"), "你好");
});

test("chat prompt carries only the selected knowledge entries, in selection order", () => {
  const group = knowledgeService.createKnowledgeGroup({ name: "Chat KB" });
  const a = knowledgeService.createKnowledgeEntry(group.id, { title: "部署流程", content: "先跑 doctor 再重启服务。" });
  const b = knowledgeService.createKnowledgeEntry(group.id, { title: "命名约定", content: "接口统一用 kebab-case。" });
  knowledgeService.createKnowledgeEntry(group.id, { title: "没勾选的条目", content: "不应该出现。" });

  const prompt = buildChatPrompt({ skillIds: [], toolIds: [], knowledgeIds: [b.id, a.id, "missing-id"] }, "怎么发布？");
  assert.match(prompt, /这次对话的知识库资料/);
  assert.ok(prompt.indexOf("命名约定") < prompt.indexOf("部署流程"));
  assert.doesNotMatch(prompt, /没勾选的条目/);
  assert.ok(prompt.endsWith("用户本轮消息：\n\n怎么发布？"));
});

const msg = (role: "user" | "agent", content: string, images: string[] = []) => ({ role, content, images });

test("chat prompt carries the earlier conversation in order, so the agent remembers what was said", () => {
  const prompt = buildChatPrompt(
    { skillIds: [], toolIds: [], knowledgeIds: [] },
    "我刚才让你记住的数字是多少？",
    [msg("user", "请记住这个数字：4729。"), msg("agent", "记住了"), msg("user", "", ["a.png", "b.png"])]
  );
  assert.match(prompt, /之前的对话记录（按时间顺序），用来理解上下文：\n\n用户：请记住这个数字：4729。\n\n你（Agent）：记住了\n\n用户：\[附图 2 张\]/);
  assert.ok(prompt.endsWith("用户本轮消息：\n\n我刚才让你记住的数字是多少？"));
});

test("chat history keeps the most recent messages within the limits and says when older ones were dropped", () => {
  const many = Array.from({ length: 30 }, (_, i) => msg(i % 2 === 0 ? "user" : "agent", `第${i}条`));
  const prompt = buildChatPrompt({ skillIds: [], toolIds: [], knowledgeIds: [] }, "现在呢", many);
  assert.match(prompt, /更早的已省略/);
  assert.doesNotMatch(prompt, /第9条/);
  assert.match(prompt, /第10条[\s\S]*第29条/);

  const long = buildChatPrompt({ skillIds: [], toolIds: [], knowledgeIds: [] }, "现在呢", [msg("user", "长".repeat(5000))]);
  assert.ok(long.includes(`${"长".repeat(1499)}…`));
  assert.ok(!long.includes("长".repeat(1500)));
});

const libItem = (kind: "tool" | "skill", title: string, content: string, command: string | null = null, tags: string[] = []) => ({
  id: `${kind}:${title}`,
  kind,
  title,
  content,
  tags,
  command,
  createdAt: "",
  updatedAt: "",
});

test("tools are listed as a cheap index and only tools related to this turn get their full description", () => {
  assert.equal(formatLibraryContext("tool", []), null);
  const tools = [
    libItem("tool", "日志查看", "生产日志在 logs 目录，排查时看最近 50 行。", "Get-Content logs\\agenthub-prod.log -Tail 50"),
    libItem("tool", "数据库备份", "每天凌晨自动备份到 backups 目录。", "npm run version:backup"),
  ];

  const unrelated = formatLibraryContext("tool", tools, { query: "继续" }) ?? "";
  assert.match(unrelated, /1\. 日志查看 命令：Get-Content logs\\agenthub-prod\.log -Tail 50/);
  assert.match(unrelated, /2\. 数据库备份 命令：npm run version:backup/);
  assert.doesNotMatch(unrelated, /生产日志在 logs 目录/);

  const related = formatLibraryContext("tool", tools, { query: "帮我看看服务的日志里有没有报错" }) ?? "";
  assert.match(related, /日志查看.*（本轮已展开）/);
  assert.match(related, /1\. 日志查看\n命令：Get-Content logs\\agenthub-prod\.log -Tail 50\n生产日志在 logs 目录，排查时看最近 50 行。/);
  assert.doesNotMatch(related, /每天凌晨自动备份/);
});

test("selected skills are always injected in full, whatever the message says, up to a size budget", () => {
  const skills = [
    libItem("skill", "回复风格", "回答一律使用简体中文，结论先行，不超过 5 条要点。"),
    libItem("skill", "代码审查规范", "审查时先看边界条件和错误处理，再看命名。"),
  ];
  for (const query of ["继续", "按上面的计划开始执行", "review this diff"]) {
    const text = formatLibraryContext("skill", skills, { query }) ?? "";
    assert.match(text, /1\. 回复风格\n回答一律使用简体中文，结论先行，不超过 5 条要点。/);
    assert.match(text, /2\. 代码审查规范\n审查时先看边界条件和错误处理，再看命名。/);
    assert.doesNotMatch(text, /命令：/);
  }

  const capped = formatLibraryContext("skill", skills, { maxSkillChars: 40 }) ?? "";
  assert.match(capped, /1\. 回复风格\n回答一律使用简体中文/);
  assert.doesNotMatch(capped, /审查时先看边界条件/);
  assert.match(capped, /超出单轮字数上限，这里只列标题：代码审查规范/);
});
