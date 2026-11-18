import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("account-note");
const { db } = await import("../src/db/index.ts");
const { getAdapter, toDescriptor } = await import("../src/adapters/registry.ts");
const { setAccountNote, getAccountNote, deleteAccountNote } = await import("../src/services/accountNoteService.ts");

after(() => {
  db.close();
  env.cleanup();
});

test("a note is attached to the agent's account, trimmed, and clearing it brings back the default label", () => {
  const codex = getAdapter("codex")!;
  assert.equal(toDescriptor(codex).account?.note, null);

  setAccountNote("codex", "  工作主号  ");
  assert.equal(toDescriptor(codex).account?.note, "工作主号");

  setAccountNote("codex", "");
  assert.equal(getAccountNote("codex"), null);
  assert.equal(toDescriptor(codex).account?.note, null);

  setAccountNote("codex", "x".repeat(100));
  assert.equal(getAccountNote("codex")?.length, 60, "kept short so the sidebar stays readable");
  deleteAccountNote("codex");
  assert.equal(getAccountNote("codex"), null);
});
