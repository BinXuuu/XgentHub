import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb } from "./helpers/testEnv.ts";

const env = setupIsolatedDb("auth-sessions");
const { db } = await import("../src/db/index.ts");
const { createSession, destroySession, isValidSession } = await import("../src/auth.ts");

after(() => {
  db.close();
  env.cleanup();
});

test("login sessions live in the database (survive a restart) and only a hash of the cookie is stored", () => {
  const id = createSession();
  assert.equal(isValidSession(id), true);
  assert.equal(isValidSession("not-a-real-session"), false);
  assert.equal(isValidSession(undefined), false);

  const rows = db.prepare("SELECT token_hash FROM auth_sessions").all() as { token_hash: string }[];
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0]?.token_hash, id, "the raw cookie value must not be stored");

  destroySession(id);
  assert.equal(isValidSession(id), false);
});

test("expired sessions are rejected and cleaned up", () => {
  const id = createSession();
  db.prepare("UPDATE auth_sessions SET expires_at = ?").run(Date.now() - 1000);
  assert.equal(isValidSession(id), false);
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM auth_sessions").get() as { c: number }).c, 0);
});
