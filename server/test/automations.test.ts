import test, { after } from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedDb, waitFor } from "./helpers/testEnv.ts";
import { describeRrule, nextRunAfter, parseRrule } from "../src/services/automationSchedule.ts";

const env = setupIsolatedDb("automations");
const { db } = await import("../src/db/index.ts");
const { waitForSnapshotsIdle } = await import("../src/services/workspaceSnapshotService.ts");
const { createWorkspace } = await import("../src/services/workspaceService.ts");
const { taskManager } = await import("../src/services/taskManager.ts");
const service = await import("../src/services/automationService.ts");

after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  await waitForSnapshotsIdle();
  db.close();
  env.cleanup();
});

// 本机时间：2026-10-28 是周三。
const at = (text: string) => new Date(text);
const local = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

test("schedule: hourly / daily / weekly next run times, in local time, strictly after the given moment", () => {
  assert.equal(local(nextRunAfter("FREQ=HOURLY;INTERVAL=6", at("2026-10-28T10:20:30"))), "2026-10-28 16:20");
  assert.equal(local(nextRunAfter("FREQ=HOURLY;INTERVAL=1;BYMINUTE=0", at("2026-10-28T10:50:00"))), "2026-10-28 11:00");
  assert.equal(local(nextRunAfter("FREQ=HOURLY;INTERVAL=24;BYMINUTE=0", at("2026-10-28T10:00:00"))), "2026-10-29 10:00");
  assert.equal(local(nextRunAfter("FREQ=DAILY;BYHOUR=9;BYMINUTE=30", at("2026-10-28T08:00:00"))), "2026-10-28 09:30");
  assert.equal(local(nextRunAfter("FREQ=DAILY;BYHOUR=9;BYMINUTE=30", at("2026-10-28T09:30:00"))), "2026-10-29 09:30", "exactly at the time → the next day");
  assert.equal(local(nextRunAfter("FREQ=DAILY;INTERVAL=3;BYHOUR=9;BYMINUTE=0", at("2026-10-28T09:00:00"))), "2026-10-31 09:00");
  // 周三晚上之后的工作日 → 周四；周五晚上之后 → 下周一。
  assert.equal(local(nextRunAfter("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0", at("2026-10-28T20:00:00"))), "2026-10-29 09:00");
  assert.equal(local(nextRunAfter("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0", at("2026-10-30T20:00:00"))), "2026-11-02 09:00");
  assert.equal(local(nextRunAfter("FREQ=WEEKLY;BYDAY=WE;BYHOUR=20;BYMINUTE=0", at("2026-10-28T20:00:00"))), "2026-11-04 20:00");
});

test("schedule: Chinese descriptions and clear errors", () => {
  assert.equal(describeRrule("FREQ=HOURLY;INTERVAL=6"), "每 6 小时");
  assert.equal(describeRrule("FREQ=HOURLY;INTERVAL=1;BYMINUTE=0"), "每小时（第 0 分）");
  assert.equal(describeRrule("FREQ=DAILY;BYHOUR=9;BYMINUTE=5"), "每天 09:05");
  assert.equal(describeRrule("FREQ=WEEKLY;BYDAY=FR,MO,WE,TU,TH;BYHOUR=9;BYMINUTE=0"), "工作日 09:00");
  assert.equal(describeRrule("FREQ=WEEKLY;BYDAY=SU,MO;BYHOUR=20;BYMINUTE=0"), "每周一、日 20:00");
  assert.throws(() => parseRrule("FREQ=MINUTELY"), /只支持/);
  assert.throws(() => parseRrule("FREQ=DAILY;BYHOUR=25"), /BYHOUR 要在 0–23/);
  assert.throws(() => parseRrule("FREQ=WEEKLY;BYDAY=XX"), /星期写错/);
});

test("schedule form: every mode builds a rule the server accepts, and editing turns it back into the same form", async () => {
  const { buildRrule, formFromRrule, DEFAULT_SCHEDULE } = await import("../../web/src/utils/automationSchedule.ts");
  const forms = [
    { ...DEFAULT_SCHEDULE, mode: "hourly" as const, intervalHours: 6, minute: 15 },
    { ...DEFAULT_SCHEDULE, mode: "daily" as const, time: "07:05" },
    { ...DEFAULT_SCHEDULE, mode: "weekdays" as const, time: "09:30" },
    { ...DEFAULT_SCHEDULE, mode: "weekly" as const, time: "20:00", days: ["SU" as const, "MO" as const] },
  ];
  assert.deepEqual(
    forms.map((form) => describeRrule(buildRrule(form))),
    ["每 6 小时（第 15 分）", "每天 07:05", "工作日 09:30", "每周一、日 20:00"]
  );
  for (const form of forms) assert.equal(buildRrule(formFromRrule(buildRrule(form))), buildRrule(form));
  assert.equal(formFromRrule("FREQ=HOURLY;INTERVAL=6").intervalHours, 6, "Codex-style rule without BYMINUTE");
  assert.throws(() => buildRrule({ ...DEFAULT_SCHEDULE, mode: "weekly", days: [] }), /至少选一天/);
  assert.throws(() => buildRrule({ ...DEFAULT_SCHEDULE, time: "25:00" }), /超出范围/);
});

const workspace = createWorkspace({ name: "Automations", path: env.root, allowedAgentKinds: [] });
const settled = (taskId: string) =>
  waitFor(() => {
    const status = taskManager.getTask(taskId)?.status;
    return status && status !== "running" ? status : null;
  }, { timeoutMs: 10_000, description: "task to finish" });

test("cron: validates input, runs on schedule by creating a task, skips while the last one is still running, then reports unread", async () => {
  assert.throws(() => service.createAutomation({ name: "x", prompt: "p", kind: "cron", rrule: "FREQ=DAILY;BYHOUR=9", agentId: "nope", workspaceId: workspace.id }), /请选择 Agent/);
  assert.throws(() => service.createAutomation({ name: "x", prompt: "p", kind: "cron", rrule: "FREQ=SECONDLY", agentId: "mock", workspaceId: workspace.id }), /只支持/);

  const automation = service.createAutomation({ name: "每日巡检", prompt: "检查一下", kind: "cron", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", agentId: "mock", workspaceId: workspace.id, permissionMode: "full" });
  assert.equal(automation.status, "ACTIVE");
  assert.equal(automation.scheduleText, "每天 09:00");
  assert.ok(automation.nextRunAt && new Date(automation.nextRunAt).getTime() > Date.now());

  // 还没到点：不触发。
  assert.deepEqual(service.runDueAutomations(new Date()), []);
  // 到点：新建一个任务，并从这一刻排到下一次。
  const due = new Date(automation.nextRunAt!);
  const [run] = service.runDueAutomations(due);
  assert.equal(run?.status, "started");
  const task = taskManager.getTask(run!.taskId!)!;
  assert.match(task.title, /^每日巡检 · \d\d-\d\d 09:00$/);
  assert.equal(task.prompt, "检查一下");
  assert.equal(task.permissionMode, "full");
  const after1 = service.getAutomation(automation.id)!;
  assert.equal(new Date(after1.nextRunAt!).getTime(), due.getTime() + 24 * 3600_000);
  assert.equal(after1.lastRunAt, due.toISOString());

  // 上一次还在跑：这次跳过，不再建新任务。
  if (taskManager.getTask(task.id)!.status === "running") {
    const skipped = service.runAutomation(automation.id, "manual");
    assert.equal(skipped.status, "skipped");
    assert.equal(skipped.taskId, task.id);
  }
  await settled(task.id);
  const runs = service.listAutomationRuns(automation.id);
  assert.ok(runs.every((item) => item.unread), "finished / skipped runs show as unread");
  assert.equal(service.automationUnreadCount(), runs.length);
  service.markAutomationRunsRead(automation.id);
  assert.equal(service.automationUnreadCount(), 0);

  // 暂停：不排期，到点也不跑；恢复后重新排期。
  const paused = service.setAutomationStatus(automation.id, "PAUSED");
  assert.equal(paused.nextRunAt, null);
  assert.deepEqual(service.runDueAutomations(new Date(Date.now() + 7 * 24 * 3600_000)), []);
  assert.ok(service.setAutomationStatus(automation.id, "ACTIVE").nextRunAt);

  service.deleteAutomation(automation.id);
  assert.equal(service.getAutomation(automation.id), null);
  assert.ok(taskManager.getTask(task.id), "tasks it created are kept");
});

test("heartbeat: sends the prompt into an existing task, and pauses itself once that task is gone", async () => {
  const target = taskManager.createTask({ agentId: "mock", workspaceId: workspace.id, title: "长期跟进", prompt: "开始", permissionMode: "full", actor: "test" });
  await settled(target.id);
  const automation = service.createAutomation({ name: "跟进", prompt: "看看有没有新进展", kind: "heartbeat", rrule: "FREQ=HOURLY;INTERVAL=6", targetTaskId: target.id });
  assert.equal(automation.agentId, null);

  const run = service.runAutomation(automation.id, "manual");
  assert.equal(run.status, "started");
  assert.equal(run.taskId, target.id);
  assert.ok(taskManager.listMessages(target.id).some((m) => m.role === "user" && m.content === "看看有没有新进展"));
  await settled(target.id);

  await taskManager.deleteTask(target.id, "test");
  const failed = service.runAutomation(automation.id, "schedule");
  assert.equal(failed.status, "failed");
  assert.match(failed.message, /已经不存在/);
  assert.equal(service.getAutomation(automation.id)!.status, "PAUSED");
});
