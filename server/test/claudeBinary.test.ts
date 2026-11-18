import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { clearClaudeBinaryCache, newestClaudeIn, resolveClaudeCodeBin } = await import("../src/adapters/claudeBinary.ts");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-claude-bin-"));
// 桌面版默认位置都指到临时目录，别读到这台电脑上真装着的 Claude。
const savedEnv = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
process.env.APPDATA = path.join(root, "home", "Roaming");
process.env.LOCALAPPDATA = path.join(root, "home", "Local");
after(() => {
  process.env.APPDATA = savedEnv.APPDATA;
  process.env.LOCALAPPDATA = savedEnv.LOCALAPPDATA;
  fs.rmSync(root, { recursive: true, force: true });
});

function fakeVersion(claudeCodeDir: string, version: string, hash: string): string {
  const dir = path.join(claudeCodeDir, version, hash);
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, "claude.exe");
  fs.writeFileSync(exe, "");
  return exe;
}

test("picks the newest version by number, not by string order", () => {
  const dir = path.join(root, "a", "Claude", "claude-code");
  fakeVersion(dir, "2.1.9", "aaa");
  const v10 = fakeVersion(dir, "2.1.10", "bbb");
  assert.equal(newestClaudeIn(dir), v10);
  const v295 = fakeVersion(dir, "2.1.295", "ccc");
  assert.equal(newestClaudeIn(dir), v295);
  assert.equal(newestClaudeIn(path.join(root, "missing")), null);
});

test("a pinned desktop-app path follows upgrades, even after the old version folder is removed", () => {
  const dir = path.join(root, "b", "Claude", "claude-code");
  const old = fakeVersion(dir, "2.1.293", "old111");
  assert.equal(resolveClaudeCodeBin(old), old);

  // 桌面版自动升级：多了新版本，旧版本目录被清掉。查找结果缓存 30 秒，先清掉缓存。
  const upgraded = fakeVersion(dir, "2.1.300", "new222");
  fs.rmSync(path.join(dir, "2.1.293"), { recursive: true, force: true });
  clearClaudeBinaryCache();
  assert.equal(resolveClaudeCodeBin(old), upgraded);
});

test("macOS layout: <version>/claude.app/Contents/MacOS/claude is found and followed across upgrades", () => {
  const dir = path.join(root, "mac", "Claude", "claude-code");
  const macBin = (version: string) => {
    const bin = path.join(dir, version, "claude.app", "Contents", "MacOS", "claude");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, "");
    return bin;
  };
  const old = macBin("2.1.219");
  assert.equal(newestClaudeIn(dir), old);
  const upgraded = macBin("2.1.300");
  fs.rmSync(path.join(dir, "2.1.219"), { recursive: true, force: true });
  clearClaudeBinaryCache();
  assert.equal(resolveClaudeCodeBin(old), upgraded);
});

test("paths outside the desktop app's versioned folder are left alone", () => {
  const custom = path.join(root, "c", "my-claude.exe");
  fs.mkdirSync(path.dirname(custom), { recursive: true });
  fs.writeFileSync(custom, "");
  assert.equal(resolveClaudeCodeBin(custom), custom);
});

test("desktop app moved claude-code to %LOCALAPPDATA%\Claude-Data: a stale pinned path finds it there", { skip: process.platform !== "win32" }, () => {
  const saved = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
  try {
    process.env.APPDATA = path.join(root, "d", "Roaming");
    process.env.LOCALAPPDATA = path.join(root, "d", "Local");
    // 旧位置（Store 版虚拟化目录）还在，但只剩一个更旧的版本；配置里写死的那个版本已经没了。
    const storeDir = path.join(root, "d", "Local", "Packages", "Claude_test123", "LocalCache", "Roaming", "Claude", "claude-code");
    fakeVersion(storeDir, "2.1.200", "older");
    const pinned = path.join(storeDir, "2.1.295", "gone", "claude.exe");
    const moved = fakeVersion(path.join(root, "d", "Local", "Claude-Data", "claude_test123", "claude-code"), "2.1.309", "newdir");
    fs.rmSync(path.join(storeDir, "2.1.200"), { recursive: true, force: true });
    clearClaudeBinaryCache();
    assert.equal(resolveClaudeCodeBin(pinned), moved);
    // 旧位置还留着更旧的版本时，也取新位置里更新的那个。
    fakeVersion(storeDir, "2.1.250", "older2");
    clearClaudeBinaryCache();
    assert.equal(resolveClaudeCodeBin(pinned), moved);
  } finally {
    process.env.APPDATA = saved.APPDATA;
    process.env.LOCALAPPDATA = saved.LOCALAPPDATA;
    clearClaudeBinaryCache();
  }
});
