import test, { after } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("resource-groups");
const { db } = await import("../src/db/index.ts");
const library = await import("../src/services/resourceLibraryService.ts");
const mcp = await import("../src/services/mcpServerService.ts");
const { registerResourceLibraryRoutes } = await import("../src/routes/resourceLibrary.ts");
const { registerMcpServerRoutes } = await import("../src/routes/mcpServers.ts");
const { createSession, SESSION_COOKIE } = await import("../src/auth.ts");

after(() => { db.close(); env.cleanup(); });

test("tools can be grouped like skills: create with a group, bulk move, delete the group leaves them ungrouped", () => {
  const group = library.saveResourceGroup("tool", { name: "部署", description: "发布相关" });
  assert.equal(group.id.startsWith("tool-group:"), true);
  assert.throws(() => library.saveResourceGroup("tool", { name: " 部署 " }), /同名工具组/);
  // 工具组和技能组是分开的：同名技能组可以有，Skill 也不能放进工具组。
  library.saveResourceGroup("skill", { name: "部署" });
  assert.throws(() => library.createResourceLibraryItem("skill", { title: "s", content: "c", groupId: group.id }), /未知技能组/);

  const a = library.createResourceLibraryItem("tool", { title: "打包", content: "npm run package", groupId: group.id });
  const b = library.createResourceLibraryItem("tool", { title: "检查", content: "npm run check" });
  assert.equal(a.groupId, group.id);
  assert.equal(b.groupId, null);
  assert.equal(library.listResourceGroups("tool")[0]!.count, 1);

  assert.throws(() => library.moveResourcesToGroup("tool", [b.id, "tool:missing"], group.id), /未知 工具/);
  library.moveResourcesToGroup("tool", [b.id], group.id);
  assert.equal(library.listResourceGroups("tool")[0]!.count, 2);
  // 编辑时不传 groupId 不会把组弄丢。
  assert.equal(library.updateResourceLibraryItem("tool", b.id, { title: "检查", content: "npm run check -- --all" }).groupId, group.id);

  assert.equal(library.deleteResourceGroup("tool", group.id), true);
  assert.ok(library.listResourceLibraryItems("tool").every((item) => item.groupId === null));
  assert.equal(library.listResourceGroups("tool").length, 0);
});

test("MCP servers keep their group through edits, can be moved in bulk, and old skill-group functions still work", () => {
  const group = library.saveResourceGroup("mcp", { name: "绘图" });
  const cad = mcp.createMcpServer({ name: "CAD", transport: "stdio", command: "python", groupId: group.id });
  const comfy = mcp.createMcpServer({ name: "ComfyUI", transport: "stdio", command: "comfy-mcp" });
  assert.equal(cad.groupId, group.id);
  assert.equal(mcp.updateMcpServer(cad.id, { name: "CAD 绘图" }).groupId, group.id);
  library.moveResourcesToGroup("mcp", [comfy.id], group.id);
  assert.equal(library.listResourceGroups("mcp")[0]!.count, 2);
  library.deleteResourceGroup("mcp", group.id);
  assert.ok(mcp.listMcpServers().every((item) => (item.groupId ?? null) === null));

  const skillGroup = library.saveSkillGroup({ name: "旧接口" });
  assert.equal(skillGroup.skillCount, 0);
  assert.equal(library.listSkillGroups().find((entry) => entry.id === skillGroup.id)!.skillCount, 0);
});

test("group routes: list / create / move / delete per kind, and MCP create rejects an unknown group", async () => {
  const app = Fastify();
  await app.register(cookie);
  registerResourceLibraryRoutes(app);
  registerMcpServerRoutes(app);
  const headers = { cookie: `${SESSION_COOKIE}=${createSession()}` };

  const created = await app.inject({ method: "POST", url: "/api/resource-groups/mcp", headers, payload: { name: "数据库" } });
  assert.equal(created.statusCode, 201);
  const groupId = created.json().id as string;
  const server = await app.inject({ method: "POST", url: "/api/mcp-servers", headers, payload: { name: "PG", transport: "stdio", command: "pg-mcp", groupId } });
  assert.equal(server.statusCode, 201);
  assert.equal(server.json().groupId, groupId);
  const bad = await app.inject({ method: "POST", url: "/api/mcp-servers", headers, payload: { name: "X", transport: "stdio", command: "x", groupId: "mcp-group:nope" } });
  assert.equal(bad.statusCode, 400);

  const moved = await app.inject({ method: "PUT", url: "/api/resource-groups/mcp/members", headers, payload: { ids: [server.json().id], groupId: null } });
  assert.equal(moved.statusCode, 200);
  const list = await app.inject({ method: "GET", url: "/api/resource-groups/mcp", headers });
  assert.equal(list.json().find((entry: { id: string }) => entry.id === groupId).count, 0);
  assert.equal((await app.inject({ method: "GET", url: "/api/resource-groups/knowledge", headers })).statusCode, 400);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/resource-groups/mcp/${encodeURIComponent(groupId)}`, headers })).statusCode, 200);
  await app.close();
});
