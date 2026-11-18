import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";
import { startMockStore } from "./helpers/mockStore.ts";

const env = setupIsolatedDb("store");
process.env.XGENT_STORE_POLL_MS = "50";
delete process.env.HTTPS_PROXY; delete process.env.https_proxy; delete process.env.HTTP_PROXY; delete process.env.http_proxy;
const officialFile = path.join(env.root, "official.json");
fs.writeFileSync(officialFile, JSON.stringify({ version: 1, items: [] }));
process.env.XGENT_CATALOG_URL = officialFile;

const mock = await startMockStore();
process.env.XGENT_STORE_URL = mock.base;

const { db } = await import("../src/db/index.ts");
const catalogs = await import("../src/services/catalogService.ts");
const store = await import("../src/services/storeAccountService.ts");
const library = await import("../src/services/resourceLibraryService.ts");
const { storeSkillEntryPath, removeStoreSkillFiles } = await import("../src/services/storeSkillService.ts");

after(async () => { store.resetStoreState(); await mock.close(); db.close(); env.cleanup(); });

async function storeItems() {
  const view = await catalogs.getCatalog(true);
  return { view, items: view.items.filter((item) => item.sourceId === "store") };
}

test("built-in store source lists skills with prices before connecting, nothing owned", async () => {
  const { view, items } = await storeItems();
  const source = view.sources.find((entry) => entry.id === "store")!;
  assert.equal(source.type, "store");
  assert.equal(source.account, null);
  assert.equal(source.catalogName, "Xgent 商店（演示）");
  assert.deepEqual(items.map((item) => [item.id, item.priceCents, item.currency, item.owned]), [
    ["weekly-report", 990, "CNY", false],
    ["code-review-checklist", 1500, "CNY", false],
    ["api-doc-writer", 1200, "CNY", false],
  ]);
  await assert.rejects(store.startStoreCheckout("store", ["weekly-report"]), /请先连接官网账号/);
  await assert.rejects(catalogs.installCatalogItem({ sourceId: "store", itemId: "weekly-report" }), /连接官网账号/);
});

test("device login: denied first, then approved; token saved locally but never shown", async () => {
  const first = await store.startStoreLogin("store");
  assert.match(first.userCode, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.ok(first.verificationUriComplete.startsWith(`${mock.origin}/device?code=`));
  mock.denyLogin();
  await waitFor(() => store.getStoreStatus("store").login?.state === "denied" || null);

  await store.startStoreLogin("store");
  await new Promise((resolve) => setTimeout(resolve, 120)); // 先轮询几次 pending
  assert.equal(store.getStoreStatus("store").login?.state, "pending");
  mock.approveLogin();
  await waitFor(() => store.getStoreStatus("store").login?.state === "connected" || null);

  const source = catalogs.listCatalogSources().find((entry) => entry.id === "store")!;
  assert.deepEqual(source.account, { email: "you@example.com", displayName: "演示用户" });
  assert.equal(source.hasKey, true);
  assert.ok(!JSON.stringify(source).includes("tok-"), "token must not be in the view");
  const saved = JSON.parse(fs.readFileSync(path.join(path.dirname(env.dbPath), "catalog-sources.json"), "utf8"));
  assert.match(saved.find((entry: { id: string }) => entry.id === "store").key, /^tok-/);
});

test("checkout opens the store page, then paid skills are found and installed automatically", async () => {
  await assert.rejects(store.startStoreCheckout("store", []), /至少选择/);
  await assert.rejects(store.startStoreCheckout("store", ["nope"]), /不在商店目录/);
  const { url, watch } = await store.startStoreCheckout("store", ["weekly-report", "api-doc-writer"]);
  assert.equal(url, `${mock.origin}/checkout?items=weekly-report%2Capi-doc-writer&from=xgent`);
  assert.equal(watch.active, true);

  // 还没付款：查一次什么都不装。
  assert.deepEqual((await store.checkStorePurchases("store")).watch!.installed, []);
  mock.pay(["weekly-report"]);
  const partial = await waitFor(() => { const w = store.getStoreStatus("store").watch!; return w.installed.length === 1 ? w : null; });
  assert.deepEqual(partial.installed, [{ id: "weekly-report", name: "周报生成" }]);
  assert.equal(partial.active, true);
  mock.pay(["api-doc-writer"]);
  const done = await waitFor(() => { const w = store.getStoreStatus("store").watch!; return w.installed.length === 2 ? w : null; }, { timeoutMs: 8000 });
  assert.equal(done.active, false);
  assert.deepEqual(done.errors, []);

  const entry = storeSkillEntryPath("store", "weekly-report");
  assert.match(fs.readFileSync(entry, "utf8"), /name: 周报生成/);
  assert.ok(fs.existsSync(path.join(path.dirname(entry), "templates", "example.md")));
  const skill = library.listResourceLibraryItems("skill").find((item) => item.sourcePath === entry)!;
  assert.equal(skill.title, "周报生成");
  assert.ok(skill.tags.includes("商店"));
  assert.equal(skill.groupId, null, "automatic installs without a category go to ungrouped");

  const { items } = await storeItems();
  const report = items.find((item) => item.id === "weekly-report")!;
  assert.equal(report.owned, true);
  assert.equal(report.status, "installed");
  await assert.rejects(store.startStoreCheckout("store", ["weekly-report"]), /已经买过了/);
});

test("a new version shows as update and reinstalls in place, keeping the library entry", async () => {
  const before = library.listResourceLibraryItems("skill").find((item) => item.sourcePath === storeSkillEntryPath("store", "weekly-report"))!;
  library.updateResourceLibraryItem("skill", before.id, { title: "我的周报", content: before.content, tags: before.tags });
  mock.skills.get("weekly-report")!.version = "1.1.0";
  const item = (await storeItems()).items.find((entry) => entry.id === "weekly-report")!;
  assert.equal(item.status, "update");
  const result = await catalogs.installCatalogItem({ sourceId: "store", itemId: "weekly-report" });
  assert.equal(result.action, "updated");
  assert.equal(result.targetId, before.id);
  assert.match(fs.readFileSync(storeSkillEntryPath("store", "weekly-report"), "utf8"), /版本 1\.1\.0/);
  assert.equal(library.getResourceLibraryItemsByIds("skill", [before.id])[0]!.title, "我的周报");
  assert.equal((await storeItems()).items.find((entry) => entry.id === "weekly-report")!.status, "installed");
});

test("bad packages are rejected and leave the installed version untouched", async () => {
  const skill = mock.skills.get("code-review-checklist")!;
  mock.pay([skill.id]);
  skill.badSha = true;
  await catalogs.getCatalog(true);
  await assert.rejects(catalogs.installCatalogItem({ sourceId: "store", itemId: skill.id }), /sha256/);
  skill.badSha = false;
  skill.zip = [{ name: "../escape.md", data: "x" }];
  await assert.rejects(catalogs.installCatalogItem({ sourceId: "store", itemId: skill.id }), /不安全/);
  skill.zip = [{ name: "readme.txt", data: "no skill here" }];
  await assert.rejects(catalogs.installCatalogItem({ sourceId: "store", itemId: skill.id }), /SKILL\.md/);
  assert.equal(fs.existsSync(path.dirname(storeSkillEntryPath("store", skill.id))), false);
  assert.ok(!fs.readdirSync(path.join(path.dirname(env.dbPath), "skills", "store", "store")).some((name) => name.includes(".tmp-")), "no temp folders left");
  // 下载链接不能带登录令牌（mock 收到令牌会返回 400），上面的正常安装已经验证过。
  assert.ok(mock.requests.some((line) => line.startsWith("GET /files/weekly-report-1.1.0.zip")));
});

test("skills already in the website library but not on this computer stay installable, even if the store hides them", async () => {
  mock.hideOwnedFree = true;
  mock.skills.set("free-a", { id: "free-a", group: "office", version: "1", name: "免费甲", summary: "免费的", priceCents: 0 });
  mock.skills.set("free-b", { id: "free-b", group: "office", version: "1", name: "免费乙", summary: "免费的", priceCents: 0 });
  // 在官网先把 free-a 加进了「我的库」，这台电脑还没装：商店目录里已经看不到它了。
  mock.pay(["free-a"]);
  const { view, items } = await storeItems();
  const freeA = items.find((item) => item.id === "free-a")!;
  assert.equal(freeA.owned, true);
  assert.equal(freeA.status, "not_installed");
  assert.match(freeA.summary, /我的库/);
  assert.equal(items.find((item) => item.id === "free-b")!.owned, false);
  // 「去官网看更多」的地址：目录和分组给的 url。
  assert.equal(view.sources.find((entry) => entry.id === "store")!.homeUrl, `${mock.origin}/skills`);
  assert.equal(view.groups.find((group) => group.sourceId === "store" && group.id === "office")!.url, `${mock.origin}/skills?group=office`);

  // 去官网挑选：之后新加入库的自动装，原来就在库里的不自动装（在「我的库」里手动装）。
  const watch = await store.startStoreBrowse("store");
  assert.equal(watch.browse, true);
  assert.equal(watch.active, true);
  mock.pay(["free-b"]);
  const got = await waitFor(() => { const w = store.getStoreStatus("store").watch!; return w.installed.length === 1 ? w : null; });
  assert.deepEqual(got.installed, [{ id: "free-b", name: "免费乙" }]);
  assert.equal(got.active, true, "还在等，直到点结束或 15 分钟到");
  assert.ok(fs.existsSync(storeSkillEntryPath("store", "free-b")));
  assert.equal(fs.existsSync(storeSkillEntryPath("store", "free-a")), false);
  assert.equal((await storeItems()).items.find((item) => item.id === "free-b")!.status, "installed");

  // 手动装原来就在库里的。
  const result = await catalogs.installCatalogItem({ sourceId: "store", itemId: "free-a" });
  assert.equal(result.action, "installed");
  assert.equal((await storeItems()).items.find((item) => item.id === "free-a")!.status, "installed");

  assert.equal(store.stopStoreBrowse("store").watch!.active, false);
  mock.hideOwnedFree = false;
});

test("store MCPs and tools: listed ones install like catalog items, library ones (even unlisted) show up and auto-install", async () => {
  mock.libraryApi = true;
  mock.extensions.set("mcp-listed", { listed: true, item: { id: "mcp-listed", kind: "mcp", group: "dev", version: "1", name: "listed-mcp", summary: "目录里的 MCP", mcp: { transport: "stdio", command: "npx", args: ["-y", "listed-mcp"] }, detailUrl: `${mock.origin}/mcp/mcp-listed` } });
  mock.extensions.set("mcp-sse", { listed: true, item: { id: "mcp-sse", kind: "mcp", group: "dev", version: "1", name: "old-sse", summary: "SSE", mcp: { transport: "http", url: "https://x.example/sse", remoteType: "sse" } } });
  mock.extensions.set("mcp-hidden", { listed: false, item: { id: "mcp-hidden", kind: "mcp", group: "dev", version: "1", name: "hidden-mcp", summary: "几万个里的一个，不进目录", mcp: { transport: "http", url: "https://mcp.example.com/{{team}}" }, inputs: [{ key: "team", label: "团队", required: true }] } });
  mock.extensions.set("tool-hidden", { listed: false, item: { id: "tool-hidden", kind: "tool", group: "dev", version: "1", name: "隐藏工具", summary: "工具", tool: { content: "用法说明", command: "foo --help" } } });

  const { view, items } = await storeItems();
  const listed = items.find((item) => item.id === "mcp-listed")!;
  assert.equal(listed.kind, "mcp");
  assert.equal(listed.owned, undefined, "MCP 不分买没买");
  assert.equal(listed.priceCents, undefined);
  assert.ok(!items.some((item) => item.id === "mcp-sse"));
  assert.ok(view.warnings.some((warning) => warning.includes("SSE")));
  // 目录里的 MCP 直接按配置装，不从商店下载。
  assert.equal((await catalogs.installCatalogItem({ sourceId: "store", itemId: "mcp-listed" })).kind, "mcp");

  // 去官网挑选，在官网把一个工具和一个要填参数的 MCP 加进「我的库」。
  await store.startStoreBrowse("store");
  mock.savedExtensions.add("tool-hidden");
  mock.savedExtensions.add("mcp-hidden");
  const got = await waitFor(() => { const w = store.getStoreStatus("store").watch!; return w.installed.length && w.errors.length ? w : null; });
  assert.deepEqual(got.installed, [{ id: "tool-hidden", name: "隐藏工具" }]);
  assert.match(got.errors.join("\n"), /hidden-mcp.*需要先填参数（「团队」）/);
  const after = (await storeItems()).items;
  assert.equal(after.find((item) => item.id === "tool-hidden")!.status, "installed");
  const hidden = after.find((item) => item.id === "mcp-hidden")!;
  assert.equal(hidden.owned, true);
  assert.equal(hidden.status, "not_installed");
  // 填好参数手动装。
  assert.equal((await catalogs.installCatalogItem({ sourceId: "store", itemId: "mcp-hidden", inputs: { team: "a" } })).action, "installed");
  store.stopStoreBrowse("store");
  mock.libraryApi = false;
  mock.extensions.clear();
});

test("the page only gets a few store items per group plus real totals; search runs on the server", async () => {
  for (let i = 1; i <= 15; i++) mock.skills.set(`bulk-${i}`, { id: `bulk-${i}`, group: "dev", version: "1", name: `批量 ${i}`, summary: i === 7 ? "独一无二的关键词" : "批量条目", priceCents: 100 });
  await catalogs.getCatalog(true);
  const page = await catalogs.getCatalogPage(false);
  const devAll = (await catalogs.getCatalog()).items.filter((item) => item.sourceId === "store" && item.group === "dev");
  const devShown = page.items.filter((item) => item.sourceId === "store" && item.group === "dev" && !(item.owned && item.status !== "installed"));
  assert.ok(devAll.length > catalogs.STORE_PREVIEW);
  assert.equal(devShown.length, catalogs.STORE_PREVIEW);
  assert.equal(page.totals.groups["store::dev"], devAll.length);
  assert.equal(page.totals.storeMatched, null);
  const found = await catalogs.getCatalogPage(false, "独一无二");
  assert.deepEqual(found.items.filter((item) => item.sourceId === "store").map((item) => item.id), ["bulk-7"]);
  assert.equal(found.totals.storeMatched, 1);
  for (let i = 1; i <= 15; i++) mock.skills.delete(`bulk-${i}`);
});

test("an unreachable store shows an error instead of the bundled official catalog", async () => {
  const saved = catalogs.saveCatalogSource({ type: "store", url: "http://127.0.0.1:9/api/xgent/v1", name: "关着的商店" });
  const view = await catalogs.getCatalog(true);
  const source = view.sources.find((entry) => entry.id === saved.id)!;
  assert.match(source.error ?? "", /连不上商店 http:\/\/127\.0\.0\.1:9/);
  assert.equal(view.items.filter((item) => item.sourceId === saved.id).length, 0);
  catalogs.deleteCatalogSource(saved.id);
});

test("the built-in store's token only goes to the address it was issued for", () => {
  assert.equal(catalogs.listCatalogSources().find((entry) => entry.id === "store")!.hasKey, true);
  // 环境变量换成别的商店地址（比如从本机开发的官网换成正式官网）：不带旧令牌，要重新连接。
  process.env.XGENT_STORE_URL = "https://store.example.com/api/xgent/v1";
  const moved = catalogs.listCatalogSources().find((entry) => entry.id === "store")!;
  assert.equal(moved.hasKey, false);
  assert.equal(moved.account, null);
  assert.equal(catalogs.getStoreSource("store").key, null);
  // 换回原地址，令牌还在。
  process.env.XGENT_STORE_URL = mock.base;
  assert.equal(catalogs.listCatalogSources().find((entry) => entry.id === "store")!.hasKey, true);
});

test("revoked token falls back to the public catalog, forgets the token and asks to reconnect", async () => {
  mock.revokeTokens();
  const { view, items } = await storeItems();
  assert.ok(view.warnings.some((warning) => warning.includes("重新连接")));
  assert.ok(items.every((item) => item.owned === false));
  assert.equal(view.sources.find((entry) => entry.id === "store")!.hasKey, false);
  const source = catalogs.listCatalogSources().find((entry) => entry.id === "store")!;
  assert.equal(source.hasKey, false);
  assert.equal(source.account, null);
  // 再读一次就不带令牌了，也不再提示。
  assert.ok(!(await storeItems()).view.warnings.some((warning) => warning.includes("重新连接")));
  store.disconnectStore("store");
  // 已装好的不受影响，删除技能库条目时会顺带删掉商店下载的文件。
  const entry = storeSkillEntryPath("store", "api-doc-writer");
  assert.ok(fs.existsSync(entry));
  assert.equal(removeStoreSkillFiles(entry), true);
  assert.equal(fs.existsSync(path.dirname(entry)), false);
  assert.equal(removeStoreSkillFiles(path.join(env.root, "elsewhere", "SKILL.md")), false);
});

test("user-added store sources need an http address and keep the token only for the same address", async () => {
  assert.throws(() => catalogs.saveCatalogSource({ type: "store", url: "D:/local/store" }), /http/);
  const added = catalogs.saveCatalogSource({ type: "store", url: mock.base, name: "另一个商店" });
  assert.equal(added.type, "store");
  catalogs.setStoreCredentials(added.id, "tok-x", { id: "u", email: "a@b.c", displayName: "A" });
  catalogs.saveCatalogSource({ name: "改个名" }, added.id);
  assert.equal(catalogs.listCatalogSources().find((entry) => entry.id === added.id)!.hasKey, true);
  catalogs.saveCatalogSource({ url: `${mock.origin}/other/v1` }, added.id);
  const moved = catalogs.listCatalogSources().find((entry) => entry.id === added.id)!;
  assert.equal(moved.hasKey, false);
  assert.equal(moved.account, null);
  assert.throws(() => catalogs.deleteCatalogSource("store"), /不能删除/);
  assert.equal(catalogs.deleteCatalogSource(added.id), true);
});
