import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("github-skills");

// 本机假 GitHub：commits / git/trees 两个 API，加上 raw 文件。
const APACHE = "                                 Apache License\n                           Version 2.0, January 2004\n";
const PROPRIETARY = "© 2025 Example, Inc. All rights reserved.\n\nLICENSE: governed by the Terms of Service.";
let files: Record<string, string> = {};
let commit = "c1";
let apiStatus = 200;
let rawHits = 0;
function setRepo(next: Record<string, string>, sha: string) { files = next; commit = sha; }
setRepo({
  "README.md": "# demo",
  "LICENSE": "MIT License\n\nCopyright (c) demo",
  "skills/alpha/SKILL.md": "---\nname: alpha\ndescription: \"Alpha does \\\"quoted\\\" things\"\nlicense: Apache-2.0\n---\n# Alpha v1",
  "skills/alpha/LICENSE.txt": APACHE,
  "skills/alpha/scripts/run.py": "print('alpha')",
  "skills/alpha/nested/SKILL.md": "---\nname: nested\ndescription: >\n  Folded line one\n  line two\n---\n# Nested",
  "skills/beta/SKILL.md": "---\nname: beta\ndescription: Beta docs\nlicense: Proprietary. LICENSE.txt has complete terms\n---\n# Beta",
  "skills/beta/LICENSE.txt": PROPRIETARY,
  "skills/gamma/SKILL.md": "# no frontmatter",
}, "c1");

const server = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (url.pathname.startsWith("/repos/")) {
    if (apiStatus !== 200) return json(apiStatus, { message: "nope" });
    if (!url.pathname.startsWith("/repos/demo/skills/")) return json(404, { message: "Not Found" });
    if (url.pathname.startsWith("/repos/demo/skills/commits/")) return json(200, { sha: commit });
    if (url.pathname === `/repos/demo/skills/git/trees/${commit}`) {
      return json(200, { truncated: false, tree: Object.entries(files).map(([p, body]) => ({ path: p, type: "blob", mode: "100644", size: Buffer.byteLength(body) })) });
    }
    return json(404, { message: "Not Found" });
  }
  const prefix = `/demo/skills/${commit}/`;
  if (url.pathname.startsWith(prefix)) {
    const file = decodeURIComponent(url.pathname.slice(prefix.length));
    if (file in files) { rawHits++; res.writeHead(200); res.end(files[file]); return; }
  }
  res.writeHead(404); res.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.XGENT_GITHUB_API_BASE = base;
process.env.XGENT_GITHUB_RAW_BASE = base;
delete process.env.HTTPS_PROXY; delete process.env.https_proxy; delete process.env.HTTP_PROXY; delete process.env.http_proxy;

const { db } = await import("../src/db/index.ts");
const library = await import("../src/services/resourceLibraryService.ts");
const gh = await import("../src/services/githubSkillService.ts");

after(() => { server.close(); db.close(); env.cleanup(); });

test("parses repo, tree and blob links", () => {
  assert.deepEqual(gh.parseGithubUrl("https://github.com/anthropics/skills"), { owner: "anthropics", repo: "skills", ref: null, path: "" });
  assert.deepEqual(gh.parseGithubUrl("github.com/a/b.git"), { owner: "a", repo: "b", ref: null, path: "" });
  assert.deepEqual(gh.parseGithubUrl("https://github.com/a/b/tree/main/skills/pdf/"), { owner: "a", repo: "b", ref: "main", path: "skills/pdf" });
  assert.deepEqual(gh.parseGithubUrl("https://github.com/a/b/blob/v2/skills/pdf/SKILL.md"), { owner: "a", repo: "b", ref: "v2", path: "skills/pdf" });
  assert.throws(() => gh.parseGithubUrl("https://gitlab.com/a/b"), /github\.com/);
  assert.throws(() => gh.parseGithubUrl("https://github.com/a"), /仓库名/);
  assert.throws(() => gh.parseGithubUrl("https://github.com/a/b/issues/3"), /tree/);
});

test("frontmatter and license classification", () => {
  const fm = gh.parseSkillFrontmatter("---\nname: x\ndescription: |\n  line1\n  line2\nlicense: 'it''s MIT'\n---\nbody");
  assert.equal(fm.name, "x");
  assert.equal(fm.description, "line1\nline2");
  assert.equal(fm.license, "it's MIT");
  assert.deepEqual(gh.parseSkillFrontmatter("no frontmatter"), {});
  assert.deepEqual(gh.classifyLicense(APACHE), { license: "Apache-2.0", openLicense: true });
  assert.deepEqual(gh.classifyLicense(PROPRIETARY), { license: "专有许可", openLicense: false });
  assert.deepEqual(gh.classifyLicense("Proprietary. LICENSE.txt has complete terms"), { license: "专有许可", openLicense: false });
  assert.deepEqual(gh.classifyLicense(""), { license: "未注明", openLicense: null });
});

test("preview lists every skill with its own license and ignores files of nested skills", async () => {
  const preview = await gh.previewGithubSkills("https://github.com/demo/skills");
  assert.equal(preview.commit, "c1");
  const byPath = Object.fromEntries(preview.skills.map((skill) => [skill.path, skill]));
  assert.deepEqual(Object.keys(byPath).sort(), ["skills/alpha", "skills/alpha/nested", "skills/beta", "skills/gamma"]);
  assert.equal(byPath["skills/alpha"]!.description, 'Alpha does "quoted" things');
  assert.equal(byPath["skills/alpha"]!.files, 3, "nested/SKILL.md belongs to the nested skill");
  assert.equal(byPath["skills/alpha"]!.license, "Apache-2.0");
  assert.equal(byPath["skills/alpha/nested"]!.description, "Folded line one line two");
  assert.equal(byPath["skills/alpha/nested"]!.license, "MIT", "falls back to the repository LICENSE");
  assert.equal(byPath["skills/beta"]!.openLicense, false);
  assert.equal(byPath["skills/gamma"]!.name, "gamma");
  assert.ok(preview.skills.every((skill) => !skill.installed));

  const one = await gh.previewGithubSkills("https://github.com/demo/skills/tree/main/skills/beta");
  assert.deepEqual(one.skills.map((skill) => skill.path), ["skills/beta"]);
});

test("install downloads files, groups by repository, and reinstall updates files but keeps edits", async () => {
  const result = await gh.installGithubSkills({ url: "https://github.com/demo/skills", paths: ["skills/alpha", "skills/beta", "skills/missing"] });
  assert.equal(result.installed, 2);
  assert.equal(result.updated, 0);
  assert.ok(result.warnings.some((warning) => warning.includes("beta") && warning.includes("专有")));
  assert.ok(result.warnings.some((warning) => warning.includes("skills/missing")));
  const group = library.listSkillGroups().find((entry) => entry.id === result.groupId)!;
  assert.equal(group.name, "demo/skills");
  assert.equal(group.source, "github:demo/skills");
  assert.equal(group.skillCount, 2);

  const alpha = library.listResourceLibraryItems("skill").find((item) => item.title === "alpha")!;
  const dir = path.dirname(alpha.sourcePath!);
  assert.equal(dir, path.join(gh.githubSkillsRoot(), "demo", "skills", "skills", "alpha"));
  assert.equal(fs.readFileSync(alpha.sourcePath!, "utf8"), files["skills/alpha/SKILL.md"]);
  assert.equal(fs.readFileSync(path.join(dir, "scripts", "run.py"), "utf8"), "print('alpha')");
  assert.ok(!fs.existsSync(path.join(dir, "nested")), "nested skill is not copied into its parent");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "XGENT-SOURCE.json"), "utf8")).commit, "c1");
  assert.deepEqual(alpha.tags, ["GitHub", "demo/skills", "Apache-2.0"]);

  library.updateResourceLibraryItem("skill", alpha.id, { title: "我的 alpha", content: "改过的说明" });
  const v2 = { ...files, "skills/alpha/SKILL.md": "---\nname: alpha\ndescription: v2\n---\n# Alpha v2" };
  delete v2["skills/alpha/scripts/run.py"];
  setRepo(v2, "c2");
  const again = await gh.installGithubSkills({ url: "https://github.com/demo/skills", paths: ["skills/alpha"] });
  assert.equal(again.installed, 0);
  assert.equal(again.updated, 1);
  const items = library.listResourceLibraryItems("skill").filter((item) => item.sourcePath === alpha.sourcePath);
  assert.equal(items.length, 1, "no duplicate entry");
  assert.equal(items[0]!.title, "我的 alpha");
  assert.equal(items[0]!.content, "改过的说明");
  assert.match(fs.readFileSync(alpha.sourcePath!, "utf8"), /Alpha v2/);
  assert.ok(!fs.existsSync(path.join(dir, "scripts", "run.py")), "files removed upstream disappear on update");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "XGENT-SOURCE.json"), "utf8")).commit, "c2");
  assert.ok(!fs.readdirSync(path.dirname(dir)).some((name) => name.includes(".tmp-") || name.includes(".old-")));

  const preview = await gh.previewGithubSkills("https://github.com/demo/skills");
  assert.equal(preview.skills.find((skill) => skill.path === "skills/alpha")!.installed, true);
});

test("install into a chosen group, reject unsafe paths, and keep the old version when a download fails", async () => {
  const mine = library.saveSkillGroup({ name: "我的精选" });
  const result = await gh.installGithubSkills({ url: "https://github.com/demo/skills/tree/main/skills/gamma", paths: ["skills/gamma"], groupId: mine.id });
  assert.equal(result.installed, 1);
  assert.equal(library.listSkillGroups().find((entry) => entry.id === mine.id)!.skillCount, 1);
  await assert.rejects(gh.installGithubSkills({ url: "https://github.com/demo/skills", paths: ["skills/gamma"], groupId: "skill-group:missing" }), /未知技能组/);
  await assert.rejects(gh.installGithubSkills({ url: "https://github.com/demo/skills", paths: [] }), /至少选择/);

  setRepo({ ...files, "skills/evil/SKILL.md": "---\nname: evil\n---", "skills/evil/../../../escape.txt": "x" }, "c3");
  const evil = await gh.installGithubSkills({ url: "https://github.com/demo/skills", paths: ["skills/evil"] });
  assert.equal(evil.installed, 0);
  assert.ok(evil.warnings.some((warning) => warning.includes("不安全")));
  assert.ok(!fs.existsSync(path.join(gh.githubSkillsRoot(), "demo", "escape.txt")));

  const gammaPath = library.listResourceLibraryItems("skill").find((item) => item.title === "gamma")!.sourcePath!;
  setRepo({ ...files, "skills/gamma/big.bin": "x" }, "c4");
  const originalHandler = server.listeners("request")[0] as http.RequestListener;
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    if (req.url?.endsWith("/big.bin")) { res.writeHead(500); res.end(); return; }
    originalHandler(req, res);
  });
  try {
    const failed = await gh.installGithubSkills({ url: "https://github.com/demo/skills", paths: ["skills/gamma"] });
    assert.equal(failed.updated, 0);
    assert.ok(failed.warnings.some((warning) => warning.includes("big.bin")));
    assert.equal(fs.readFileSync(gammaPath, "utf8"), "# no frontmatter", "previous version stays in place");
    assert.ok(!fs.readdirSync(path.dirname(path.dirname(gammaPath))).some((name) => name.includes(".tmp-")));
  } finally {
    server.removeAllListeners("request");
    server.on("request", originalHandler);
  }
});

test("clear errors for missing repos and rate limits", async () => {
  await assert.rejects(gh.previewGithubSkills("https://github.com/demo/other"), /没找到这个仓库/);
  apiStatus = 403;
  try {
    await assert.rejects(gh.previewGithubSkills("https://github.com/demo/skills"), /GITHUB_TOKEN/);
  } finally { apiStatus = 200; }
});

test("deleting files only touches skills downloaded from GitHub", () => {
  const alpha = library.listResourceLibraryItems("skill").find((item) => item.title === "我的 alpha")!;
  const dir = path.dirname(alpha.sourcePath!);
  const outside = path.join(env.root, "outside-skill");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "SKILL.md"), "x");
  fs.writeFileSync(path.join(outside, "XGENT-SOURCE.json"), "{}");
  assert.equal(gh.removeGithubSkillFiles(path.join(outside, "SKILL.md")), false);
  assert.ok(fs.existsSync(outside));
  assert.equal(gh.removeGithubSkillFiles(null), false);
  assert.equal(gh.removeGithubSkillFiles(alpha.sourcePath), true);
  assert.ok(!fs.existsSync(dir));
  assert.ok(rawHits > 0);
});
