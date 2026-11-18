import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractZip } from "../src/services/zipExtract.ts";
import { buildZip } from "./helpers/zipBuilder.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-zip-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const dest = () => path.join(root, `out-${n++}`);

test("extracts stored and deflated files, folders and utf-8 names", () => {
  const out = dest();
  const files = extractZip(buildZip([
    { name: "demo/" },
    { name: "demo/SKILL.md", data: "---\nname: demo\n---\n" },
    { name: "demo/模板/说明.txt", data: "你好".repeat(1000), method: 8 },
    { name: "demo/raw.bin", data: Buffer.from([0, 1, 2, 255]), method: 0 },
  ]), out);
  assert.deepEqual(files, ["demo/SKILL.md", "demo/模板/说明.txt", "demo/raw.bin"]);
  assert.equal(fs.readFileSync(path.join(out, "demo", "模板", "说明.txt"), "utf8"), "你好".repeat(1000));
  assert.deepEqual([...fs.readFileSync(path.join(out, "demo", "raw.bin"))], [0, 1, 2, 255]);
});

test("rejects path traversal, absolute paths and backslashes without writing outside", () => {
  for (const name of ["../evil.txt", "demo/../../evil.txt", "/etc/passwd", "C:/Windows/x.txt", "demo\\..\\evil.txt", "demo//x.txt"]) {
    const out = dest();
    assert.throws(() => extractZip(buildZip([{ name, data: "x" }]), out), /不安全/, name);
  }
  assert.equal(fs.existsSync(path.join(root, "evil.txt")), false);
});

test("rejects symlinks, encrypted entries, lies about size, and zip bombs", () => {
  assert.throws(() => extractZip(buildZip([{ name: "demo/link", data: "/etc/passwd", symlink: true }]), dest()), /符号链接/);
  assert.throws(() => extractZip(buildZip([{ name: "demo/a", data: "x", encrypted: true }]), dest()), /加密/);
  // 目录里说 1 字节，实际解压出 1MB：按上限截断后报错，不会真的写出 1MB。
  assert.throws(() => extractZip(buildZip([{ name: "bomb", data: Buffer.alloc(1024 * 1024), fakeSize: 1 }]), dest()), /不安全/);
  const limits = { maxEntries: 2, maxFileBytes: 1024, maxTotalBytes: 1500 };
  assert.throws(() => extractZip(buildZip([{ name: "a" }, { name: "b" }, { name: "c" }]), dest(), limits), /文件太多/);
  assert.throws(() => extractZip(buildZip([{ name: "a", data: Buffer.alloc(2000) }]), dest(), limits), /太大/);
  assert.throws(() => extractZip(buildZip([{ name: "a", data: Buffer.alloc(1000) }, { name: "b", data: Buffer.alloc(1000) }]), dest(), limits), /解压后太大/);
  assert.throws(() => extractZip(Buffer.from("not a zip at all, definitely not"), dest()), /不是 zip/);
});

test("rejects duplicate names and corrupted data", () => {
  assert.throws(() => extractZip(buildZip([{ name: "a.txt", data: "1" }, { name: "a.txt", data: "2" }]), dest()), /重复/);
  // Windows 上不分大小写，a.txt 和 A.txt 会互相覆盖，也算重复。
  if (process.platform === "win32") assert.throws(() => extractZip(buildZip([{ name: "a.txt", data: "1" }, { name: "A.txt", data: "2" }]), dest()), /重复/);
  const zip = buildZip([{ name: "a.txt", data: "hello world hello world", method: 0 }]);
  zip[30 + "a.txt".length] ^= 0xff; // 改坏第一个字节
  assert.throws(() => extractZip(zip, dest()), /校验和不符/);
});
