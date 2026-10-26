import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("catalog");

// 一个本机 HTTP 服务同时扮演：假 GitHub（commits / trees / raw）和需要密钥的会员目录。
const skillFiles: Record<string, string> = {
  "skills/demo/SKILL.md": "---\nname: demo\ndescription: Demo skill\n---\n# Demo",
  "skills/demo/LICENSE.txt": "MIT License",
};
let memberCatalog = "";
let officialStatus = 200;
let lastAuth: string | undefined;
const server = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
  if (url.pathname === "/member/catalog.json") {
    lastAuth = req.headers.authorization;
    return req.headers.authorization === "Bearer vip-key" ? json(200, memberCatalog) : json(401, { error: "no" });
  }
  if (url.pathname === "/official/catalog.json") return json(officialStatus, officialStatus === 200 ? fs.readFileSync(officialFile, "utf8") : { error: "down" });
  if (url.pathname.startsWith("/repos/demo/skills/commits/")) return json(200, { sha: "abc" });
  if (url.pathname === "/repos/demo/skills/git/trees/abc") {
    return json(200, { tree: Object.entries(skillFiles).map(([p, body]) => ({ path: p, type: "blob", mode: "100644", size: body.length })) });
  }
  const raw = url.pathname.replace(/^\/demo\/skills\/abc\//, "");
  if (raw in skillFiles) { res.writeHead(200); res.end(skillFiles[raw]); return; }
  res.writeHead(404); res.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.XGENT_GITHUB_API_BASE = base;
process.env.XGENT_GITHUB_RAW_BASE = base;
delete process.env.HTTPS_PROXY; delete process.env.https_proxy; delete process.env.HTTP_PROXY; delete process.env.http_proxy;

function catalog(items: unknown[], extra: object = {}) {
  return JSON.stringify({ version: 1, name: "测试目录", groups: [{ id: "g1", name: "测试组" }], items, ...extra });
}
const toolItem = { id: "tool-a", kind: "tool", group: "g1", version: "1", name: "工具 A", summary: "s", tool: { content: "第一版说明", command: "a --v1" } };
const mcpItem = {
  id: "mcp-a", kind: "mcp", group: "g1", version: "1", name: "mcp-a", summary: "s",
  mcp: { transport: "stdio", command: "npx", args: ["-y", "pkg", "{{dir}}"], env: { TOKEN: "{{token}}" } },
  inputs: [{ key: "dir", label: "目录", required: true }, { key: "token", label: "令牌", secret: true, required: true }],
};
const skillItem = { id: "skill-a", kind: "skill", group: "g1", version: "1", name: "demo", summary: "s", source: { type: "github", repo: "demo/skills", ref: "main", path: "skills/demo" } };
const officialFile = path.join(env.root, "official.json");
fs.writeFileSync(officialFile, catalog([toolItem, mcpItem, skillItem, { id: "bad id", kind: "tool", version: "1", name: "坏条目" }, { id: "x", kind: "skill", version: "1", name: "越界", source: { type: "github", repo: "a/b", path: "../etc" } }]));
process.env.XGENT_CATALOG_URL = officialFile;

const { db } = await import("../src/db/index.ts");
const catalogs = await import("../src/services/catalogService.ts");
const library = await import("../src/services/resourceLibraryService.ts");
const mcp = await import("../src/services/mcpServerService.ts");

after(() => { server.close(); db.close(); env.cleanup(); });

function item(view: Awaited<ReturnType<typeof catalogs.getCatalog>>, id: string) {
  return view.items.find((entry) => entry.id === id)!;
}

test("lists valid items from the built-in source and skips broken ones with a warning", async () => {
  const view = await catalogs.getCatalog(true);
  assert.equal(view.sources[0]!.id, "official");
  assert.equal(view.sources[0]!.catalogName, "测试目录");
  assert.deepEqual(view.items.map((entry) => entry.id), ["tool-a", "mcp-a", "skill-a"]);
  assert.ok(view.items.every((entry) => entry.status === "not_installed"));
  assert.equal(view.warnings.length, 2);
  assert.ok(view.warnings.some((warning) => warning.includes("越界")));
  assert.deepEqual(view.groups, [{ sourceId: "official", id: "g1", name: "测试组", description: "" }]);
  assert.throws(() => catalogs.parseCatalog("{\"version\":2}", "x"), /格式版本/);
  assert.throws(() => catalogs.parseCatalog("not json", "x"), /JSON/);
});

test("tool: install, version bump shows update, user edits need confirmation before overwrite", async () => {
  const first = await catalogs.installCatalogItem({ sourceId: "official", itemId: "tool-a" });
  assert.equal(first.action, "installed");
  const tool = library.getResourceLibraryItemsByIds("tool", [first.targetId])[0]!;
  assert.equal(tool.content, "第一版说明");
  assert.equal(tool.command, "a --v1");
  assert.equal(item(await catalogs.getCatalog(), "tool-a").status, "installed");

  fs.writeFileSync(officialFile, catalog([{ ...toolItem, version: "2", tool: { content: "第二版说明", command: "a --v2" } }, mcpItem, skillItem]));
  const updated = await catalogs.getCatalog(true);
  assert.equal(item(updated, "tool-a").status, "update");
  assert.equal(item(updated, "tool-a").installedVersion, "1");

  library.updateResourceLibraryItem("tool", first.targetId, { title: "我改的名字", content: "我改的说明", command: "a --v1" });
  await assert.rejects(catalogs.installCatalogItem({ sourceId: "official", itemId: "tool-a" }), (err: Error) => err instanceof catalogs.CatalogConflictError && /改过/.test(err.message));
  const forced = await catalogs.installCatalogItem({ sourceId: "official", itemId: "tool-a", force: true });
  assert.equal(forced.action, "updated");
  assert.equal(forced.targetId, first.targetId);
  const after2 = library.getResourceLibraryItemsByIds("tool", [first.targetId])[0]!;
  assert.equal(after2.content, "第二版说明");
  assert.equal(after2.title, "我改的名字", "the title the user chose is kept");
  assert.equal(item(await catalogs.getCatalog(), "tool-a").status, "installed");

  library.deleteResourceLibraryItem("tool", first.targetId);
  assert.equal(item(await catalogs.getCatalog(), "tool-a").status, "not_installed", "deleted targets count as not installed");
});

test("mcp: required inputs, secrets stay hidden, blank secret on update reuses the old one", async () => {
  await assert.rejects(catalogs.installCatalogItem({ sourceId: "official", itemId: "mcp-a", inputs: { dir: "D:/work" } }), /令牌/);
  const result = await catalogs.installCatalogItem({ sourceId: "official", itemId: "mcp-a", inputs: { dir: "D:/work", token: "secret-1" } });
  const server1 = mcp.getMcpServer(result.targetId)!;
  assert.deepEqual(server1.args, ["-y", "pkg", "D:/work"]);
  assert.deepEqual(server1.env, { TOKEN: "secret-1" });
  const view = item(await catalogs.getCatalog(), "mcp-a");
  assert.deepEqual(view.savedInputs, { dir: "D:/work" }, "secret input is not sent back to the page");

  fs.writeFileSync(officialFile, catalog([toolItem, { ...mcpItem, version: "2", mcp: { ...mcpItem.mcp, args: ["-y", "pkg@2", "{{dir}}"] } }, skillItem]));
  await catalogs.getCatalog(true);
  const again = await catalogs.installCatalogItem({ sourceId: "official", itemId: "mcp-a", inputs: { dir: "E:/other", token: "" } });
  assert.equal(again.action, "updated");
  const server2 = mcp.getMcpServer(result.targetId)!;
  assert.deepEqual(server2.args, ["-y", "pkg@2", "E:/other"]);
  assert.deepEqual(server2.env, { TOKEN: "secret-1" });

  mcp.updateMcpServer(result.targetId, { args: ["-y", "pkg@2", "E:/other", "--my-flag"] });
  fs.writeFileSync(officialFile, catalog([toolItem, { ...mcpItem, version: "3" }, skillItem]));
  await catalogs.getCatalog(true);
  await assert.rejects(catalogs.installCatalogItem({ sourceId: "official", itemId: "mcp-a" }), catalogs.CatalogConflictError);
});

test("skill: downloads from GitHub into a group named after the catalog group", async () => {
  const result = await catalogs.installCatalogItem({ sourceId: "official", itemId: "skill-a" });
  assert.equal(result.kind, "skill");
  const skill = library.getResourceLibraryItemsByIds("skill", [result.targetId])[0]!;
  assert.equal(skill.title, "demo");
  assert.ok(fs.existsSync(skill.sourcePath!));
  const group = library.listSkillGroups().find((entry) => entry.id === skill.groupId)!;
  assert.equal(group.name, "测试组");
  assert.equal(group.source, "catalog:official/g1");
  assert.equal(item(await catalogs.getCatalog(), "skill-a").status, "installed");
  const again = await catalogs.installCatalogItem({ sourceId: "official", itemId: "skill-a" });
  assert.equal(again.action, "updated");
  assert.equal(again.targetId, result.targetId);
  assert.equal(library.listSkillGroups().filter((entry) => entry.source === "catalog:official/g1").length, 1);
});

test("extra sources with an access key, disabled sources, and the bundled fallback", async () => {
  memberCatalog = catalog([{ ...toolItem, id: "vip-tool", name: "会员工具" }], { name: "会员目录" });
  await assert.rejects(async () => catalogs.saveCatalogSource({ url: "ftp://x" }), /http/);
  const member = catalogs.saveCatalogSource({ name: "会员", url: `${base}/member/catalog.json`, key: "wrong" });
  assert.equal(member.hasKey, true);
  let view = await catalogs.getCatalog(true);
  assert.match(view.sources.find((source) => source.id === member.id)!.error!, /访问密钥/);
  assert.equal(lastAuth, "Bearer wrong");

  catalogs.saveCatalogSource({ key: "vip-key" }, member.id);
  view = await catalogs.getCatalog(true);
  assert.equal(view.sources.find((source) => source.id === member.id)!.catalogName, "会员目录");
  const vip = view.items.find((entry) => entry.id === "vip-tool")!;
  assert.equal(vip.sourceId, member.id);
  const installed = await catalogs.installCatalogItem({ sourceId: member.id, itemId: "vip-tool" });
  assert.equal(library.getResourceLibraryItemsByIds("tool", [installed.targetId])[0]!.title, "会员工具");
  assert.ok(!JSON.stringify(catalogs.listCatalogSources()).includes("vip-key"), "keys are never returned");

  assert.throws(() => catalogs.deleteCatalogSource("official"), /不能删除/);
  catalogs.saveCatalogSource({ enabled: false }, "official");
  view = await catalogs.getCatalog();
  assert.ok(!view.items.some((entry) => entry.sourceId === "official"));
  await assert.rejects(catalogs.installCatalogItem({ sourceId: "official", itemId: "tool-a" }), /已关闭/);
  catalogs.saveCatalogSource({ enabled: true }, "official");
  assert.equal(catalogs.deleteCatalogSource(member.id), true);
  assert.ok(!(await catalogs.getCatalog()).items.some((entry) => entry.id === "vip-tool"));

  // 官方源连不上时退回随程序附带的 catalog/catalog.json。
  process.env.XGENT_CATALOG_URL = `${base}/official/catalog.json`;
  officialStatus = 500;
  view = await catalogs.getCatalog(true);
  assert.equal(view.sources[0]!.bundled, true);
  assert.ok(view.items.some((entry) => entry.id === "mcp-memory"), "bundled catalog is used");
  assert.ok(view.warnings[0]!.includes("随程序附带"));
});

test("the bundled catalog file itself is valid", () => {
  const file = path.resolve(import.meta.dirname, "../../catalog/catalog.json");
  const parsed = catalogs.parseCatalog(fs.readFileSync(file, "utf8"), "bundled");
  assert.deepEqual(parsed.warnings, []);
  assert.ok(parsed.items.length >= 10);
  const groups = new Set((parsed.file.groups ?? []).map((group) => group.id));
  assert.ok(parsed.items.every((entry) => entry.group && groups.has(entry.group)), "every item points at a declared group");
});
