import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { setupIsolatedDb } from "./helpers/testEnv.ts";
import { skillSelectionState, toggleSkillSelection } from "../../web/src/utils/skillSelection.ts";

const env = setupIsolatedDb("skill-groups");
const { db } = await import("../src/db/index.ts");
const library = await import("../src/services/resourceLibraryService.ts");
const { importInstalledPluginSkills } = await import("../src/services/installedSkillService.ts");
const { createRole, getRole } = await import("../src/services/roleService.ts");
const { registerResourceLibraryRoutes } = await import("../src/routes/resourceLibrary.ts");
const { createSession, SESSION_COOKIE } = await import("../src/auth.ts");

after(() => { db.close(); env.cleanup(); });

test("legacy skills stay ungrouped, groups validate names, and bulk moves fail without partial changes", () => {
  const legacy = library.createResourceLibraryItem("skill", { title: "旧技能", content: "保留自定义工作流程" });
  const group = library.saveSkillGroup({ name: "我的插件", description: "一组工作流程" });
  assert.equal(library.listSkillGroups().find((entry) => entry.id === group.id)?.skillCount, 0);
  assert.throws(() => library.saveSkillGroup({ name: " 我的插件 " }), /同名/);
  assert.throws(() => library.saveSkillGroup({ name: " " }), /必填/);
  assert.throws(() => library.createResourceLibraryItem("skill", { title: "x", content: "x", groupId: "missing" }), /未知技能组/);
  assert.throws(() => library.moveSkillsToGroup([legacy.id, "missing"], group.id), /未知 Skill/);
  assert.equal(library.getResourceLibraryItemsByIds("skill", [legacy.id])[0]?.groupId, null);
  library.moveSkillsToGroup([legacy.id], group.id);
  assert.equal(library.listSkillGroups().find((entry) => entry.id === group.id)?.skillCount, 1);
  const renamed = library.saveSkillGroup({ name: "改名后的插件" }, group.id);
  assert.equal(renamed.description, "一组工作流程");
  assert.equal(renamed.skillCount, 1);
  library.updateResourceLibraryItem("skill", legacy.id, { title: "编辑旧技能", content: "编辑后的步骤" });
  assert.equal(library.getResourceLibraryItemsByIds("skill", [legacy.id])[0]?.groupId, group.id, "old clients without groupId must preserve membership");
});

test("installed plugin import is grouped, idempotent, preserves edits, and retains every file entry in context", () => {
  const root = path.join(env.root, "installed");
  function fixture(name: string, metadata: object) {
    const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: fixture\n---\n完整技能与相对路径 references/steps.md");
    fs.writeFileSync(path.join(dir, "SOURCE.json"), JSON.stringify({ upstreamFrontmatter: { description: "Use when planning customer work. ".repeat(100) }, ...metadata }));
  }
  fixture("anthropic-sales-call-prep", { plugin: "sales", upstreamName: "call-prep" });
  fixture("anthropic-sales-draft-outreach", { plugin: "sales", upstreamName: "draft-outreach" });
  fixture("cinetic", { repo: "Leonxlnx/cinetic" });
  fixture("earshot", { repo: "Leonxlnx/earshot" });
  fixture("real-sound", { repo: "Leonxlnx/earshot" });
  fixture("anthropic-untrusted", { plugin: "unknown" });
  const result = importInstalledPluginSkills(root);
  assert.deepEqual({ imported: result.imported, skipped: result.skipped, groups: result.groups }, { imported: 5, skipped: 0, groups: 3 });
  assert.equal(result.warnings.length, 1);
  const imported = library.listResourceLibraryItems("skill").filter((item) => item.sourcePath);
  const earshot = library.listSkillGroups().find((group) => group.source === "Leonxlnx/earshot")!;
  assert.equal(earshot.skillCount, 2);
  const first = imported[0]!;
  library.updateResourceLibraryItem("skill", first.id, { title: "我的定制标题", content: "我的定制触发说明", groupId: null });
  const secondImport = importInstalledPluginSkills(root);
  assert.equal(secondImport.imported, 0); assert.equal(secondImport.skipped, 5);
  const edited = library.getResourceLibraryItemsByIds("skill", [first.id])[0]!;
  assert.equal(edited.title, "我的定制标题"); assert.equal(edited.groupId, null); assert.equal(edited.sourcePath, first.sourcePath);
  const context = library.formatLibraryContext("skill", imported, { maxSkillChars: 20 })!;
  for (const item of imported) assert.ok(context.includes(item.sourcePath!), `must retain ${item.title}'s original file entry`);
  assert.ok(context.includes("相对路径")); assert.ok(context.includes("文件不可访问"));
  assert.ok(!context.includes("超出单轮字数上限"));
});

test("group selection supports partial state, preserves other groups, and survives role save and group deletion", () => {
  const sales = library.listSkillGroups().find((group) => group.source?.endsWith("/sales"))!;
  const members = library.listResourceLibraryItems("skill").filter((item) => item.groupId === sales.id).map((item) => item.id);
  assert.ok(members.length > 0);
  let selected = toggleSkillSelection(["skill:elsewhere"], members);
  assert.equal(skillSelectionState(selected, members).checked, true);
  assert.deepEqual(toggleSkillSelection(selected, members), ["skill:elsewhere"]);
  assert.deepEqual(toggleSkillSelection([], []), []);
  assert.deepEqual(skillSelectionState(["a"], ["a", "b"]), { count: 1, checked: false, partial: true });
  selected = toggleSkillSelection(["a", "other"], ["a", "b"]);
  assert.deepEqual(selected, ["a", "other", "b"]);
  const role = createRole({ name: "插件分组角色", baseAgentId: "mock", baseAgentKind: "mock", skillIds: members });
  assert.deepEqual(getRole(role.id)?.skillIds, members);
  assert.equal(library.deleteSkillGroup(sales.id), true);
  assert.deepEqual(getRole(role.id)?.skillIds, members, "deleting a group must not revoke assigned skills");
  assert.ok(library.getResourceLibraryItemsByIds("skill", members).every((item) => item.groupId === null));
  assert.equal(library.deleteSkillGroup(sales.id), false);
  library.deleteResourceLibraryItem("skill", members[0]!);
  assert.ok(!getRole(role.id)?.skillIds.includes(members[0]!));
});

test("group/import endpoints require auth and membership edits work through the resource API", async () => {
  const app = Fastify(); await app.register(cookie); registerResourceLibraryRoutes(app);
  try {
    for (const [method, url] of [["GET", "/api/skill-groups"], ["POST", "/api/skill-groups"], ["PUT", "/api/skill-groups/nope"], ["DELETE", "/api/skill-groups/nope"], ["PUT", "/api/skill-group-members"], ["POST", "/api/skills/import-installed"]] as const) {
      assert.equal((await app.inject({ method, url, payload: method === "PUT" || method === "POST" ? {} : undefined })).statusCode, 401);
    }
    const headers = { cookie: `${SESSION_COOKIE}=${createSession()}` };
    const created = await app.inject({ method: "POST", url: "/api/skill-groups", headers, payload: { name: "API 插件组" } });
    assert.equal(created.statusCode, 201);
    const group = created.json();
    const itemResponse = await app.inject({ method: "POST", url: "/api/resource-library/skill", headers, payload: { title: "API 技能", content: "执行步骤", groupId: group.id } });
    assert.equal(itemResponse.statusCode, 201);
    assert.equal(itemResponse.json().groupId, group.id);
    const moved = await app.inject({ method: "PUT", url: "/api/skill-group-members", headers, payload: { ids: [itemResponse.json().id], groupId: null } });
    assert.equal(moved.statusCode, 200);
    const list = await app.inject({ method: "GET", url: "/api/skill-groups", headers });
    assert.equal(list.json().find((entry: { id: string }) => entry.id === group.id).skillCount, 0);
    const invalid = await app.inject({ method: "PUT", url: "/api/skill-group-members", headers, payload: { ids: [itemResponse.json().id], groupId: "missing" } });
    assert.equal(invalid.statusCode, 400);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/skill-groups/${encodeURIComponent(group.id)}`, headers })).statusCode, 200);
  } finally { await app.close(); }
});
