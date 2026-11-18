import test from "node:test";
import assert from "node:assert/strict";
import { getRuntimeProfile, runtimeKindFromAgentKind } from "../src/adapters/runtimeMetadata.ts";

test("runtime metadata separates execution kind from agent kind", () => {
  const codex = getRuntimeProfile("codex");
  assert.equal(codex.kind, "cli");
  assert.equal(codex.executionKind, "external-cli");
  assert.equal(codex.toolBoundary, "os-sandbox");
  assert.equal(codex.canWriteWorkspace, true);
  assert.equal(codex.supportsImages, true);

  const ollama = getRuntimeProfile("ollama");
  assert.equal(ollama.kind, "local");
  assert.equal(ollama.executionKind, "local-service");
  assert.equal(ollama.toolBoundary, "chat-only");
  assert.equal(ollama.canWriteWorkspace, false);

  const customCli = getRuntimeProfile("custom-cli");
  assert.equal(customCli.kind, "custom");
  assert.equal(customCli.toolBoundary, "user-defined");
});

test("runtimeKindFromAgentKind keeps historical runtime buckets", () => {
  assert.equal(runtimeKindFromAgentKind("openclaw"), "cli");
  assert.equal(runtimeKindFromAgentKind("tokenezgo"), "api");
  assert.equal(runtimeKindFromAgentKind("ollama"), "local");
  assert.equal(runtimeKindFromAgentKind("mock"), "mock");
});
