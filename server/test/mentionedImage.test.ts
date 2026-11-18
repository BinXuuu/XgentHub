import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("mentioned-image");
after(() => env.cleanup());
const { getMentionedImage } = await import("../src/services/attachmentService.ts");

const dir = path.join(env.root, "agent brain");
fs.mkdirSync(dir, { recursive: true });
const logo = path.join(dir, "logo.jpg");
const secret = path.join(dir, "notes.txt");
const sibling = path.join(dir, "logo.jpg.png");
fs.writeFileSync(logo, "jpg");
fs.writeFileSync(secret, "secret");
fs.writeFileSync(sibling, "png");
const posix = (p: string) => p.replace(/\\/g, "/");

test("images written in the agent's reply can be shown, in any of the usual spellings", () => {
  for (const reply of [
    `![Logo](/${posix(logo)})`,
    `[logo.jpg](file:///${encodeURI(posix(logo))})`,
    `图片在 ${logo} 里`,
  ]) {
    assert.equal(getMentionedImage(logo, [reply]).contentType, "image/jpeg", reply);
  }
});

test("only images, only paths that were actually mentioned", () => {
  assert.throws(() => getMentionedImage(logo, ["没提到路径"]), /没有提到/);
  assert.throws(() => getMentionedImage(secret, [`看 ${secret}`]), /只能显示图片/);
  // 提到的是 logo.jpg.png，不能顺带放行 logo.jpg。
  assert.throws(() => getMentionedImage(logo, [`![x](${posix(sibling)})`]), /没有提到/);
  assert.throws(() => getMentionedImage(path.join(dir, "gone.png"), [path.join(dir, "gone.png")]), /不存在/);
});
