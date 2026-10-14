import { EventEmitter } from "node:events";
import type { NotificationItem, TaskEvent } from "./types.ts";

// 全局事件总线：
// - task:<taskId>  用于单个任务的 SSE 订阅（Chat/Events/Terminal/Diff 等 tab）
// - dashboard      用于首页任务列表/审批队列的实时刷新
class Bus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);
  }

  publishTaskEvent(taskId: string, event: TaskEvent) {
    this.emit(`task:${taskId}`, event);
    this.emit("dashboard", { kind: "task_event", taskId, event });
  }

  publishTaskStatus(taskId: string, status: string) {
    const event: TaskEvent = {
      id: "",
      taskId,
      type: "status",
      payload: { status },
      createdAt: new Date().toISOString(),
    };
    this.emit(`task:${taskId}`, event);
    this.emit("dashboard", { kind: "task_status", taskId, status });
  }

  publishApproval(taskId: string, approval: unknown) {
    this.emit("dashboard", { kind: "approval", taskId, approval });
  }

  publishTaskDeleted(taskId: string) {
    this.emit("dashboard", { kind: "task_deleted", taskId });
  }

  publishNotification(notification: NotificationItem) {
    this.emit("dashboard", { kind: "notification", notification });
  }
}

export const bus = new Bus();
