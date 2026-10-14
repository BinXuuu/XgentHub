import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.ts";
import { taskManager } from "../services/taskManager.ts";
import { planSubtasks } from "../services/subtaskPlannerService.ts";
import { planMultiAgentTask } from "../services/multiAgentPlannerService.ts";
import { bus } from "../eventBus.ts";
import { startSSE } from "./sseHelper.ts";
import type { ApprovalDecision, MultiAgentPlan, PermissionMode } from "../types.ts";

interface CreateTaskBody {
  agentId: string;
  workspaceId: string;
  title: string;
  prompt?: string;
  images?: string[];
  model?: string;
  permissionMode?: PermissionMode;
  subAgentId?: string;
  budgetLimitCny?: number | null;
  autoPlanSubtasks?: boolean;
  multiAgentPlan?: MultiAgentPlan;
  autoAdvancePlan?: boolean;
  planMode?: boolean;
}

interface PlanSubtasksBody {
  prompt: string;
}

interface PlanMultiAgentBody {
  prompt: string;
  workspaceId?: string | null;
  plannerAgentId: string;
}

interface SendMessageBody {
  message: string;
  images?: string[];
}

interface ChangeWorkspaceBody {
  workspaceId: string;
  confirmed?: boolean;
}

interface RenameTaskBody {
  title?: string;
}

interface AutoAdvancePlanBody {
  enabled: boolean;
}

interface TaskModelBody {
  model?: string | null;
}

interface DecideApprovalBody {
  decision: ApprovalDecision;
  note?: string;
}

interface EnqueueBody {
  content: string;
  images?: string[];
}

interface RecoveryBody {
  note?: string;
}

interface AgentHandoffBody {
  agentId: string;
  prompt: string;
  subtaskId?: string | null;
  model?: string | null;
  images?: string[];
}

interface DispatchNextSubtaskBody {
  agentId?: string | null;
  prompt?: string | null;
  model?: string | null;
  images?: string[];
}

interface ReviewBody {
  note?: string;
}

interface ReorderQueueBody {
  orderedIds: string[];
}

export function registerTaskRoutes(app: FastifyInstance) {
  app.get("/api/tasks", { preHandler: requireAuth }, async () => taskManager.listTasks());

  app.post<{ Body: PlanSubtasksBody }>("/api/tasks/plan-subtasks", { preHandler: requireAuth }, async (req, reply) => {
    const prompt = req.body?.prompt?.trim();
    if (!prompt) {
      reply.code(400);
      return { error: "prompt 为必填项" };
    }
    try {
      return planSubtasks(prompt);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.post<{ Body: PlanMultiAgentBody }>("/api/tasks/plan-multi-agent", { preHandler: requireAuth }, async (req, reply) => {
    const prompt = req.body?.prompt?.trim();
    const plannerAgentId = req.body?.plannerAgentId?.trim();
    if (!prompt || !plannerAgentId) {
      reply.code(400);
      return { error: "prompt / plannerAgentId 均为必填项" };
    }
    try {
      return await planMultiAgentTask({ prompt, workspaceId: req.body?.workspaceId ?? null, plannerAgentId });
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.post<{ Body: CreateTaskBody }>("/api/tasks", { preHandler: requireAuth }, async (req, reply) => {
    const {
      agentId,
      workspaceId,
      title,
      prompt,
      images,
      model,
      permissionMode,
      subAgentId,
      budgetLimitCny,
      autoPlanSubtasks,
      multiAgentPlan,
      autoAdvancePlan,
      planMode,
    } = req.body ?? ({} as CreateTaskBody);
    if (!agentId || !workspaceId || !title?.trim()) {
      reply.code(400);
      return { error: "agentId / workspaceId / title 均为必填项" };
    }
    try {
      const task = taskManager.createTask({
        agentId,
        workspaceId,
        title: title.trim(),
        prompt: prompt?.trim() ?? "",
        images,
        model,
        permissionMode,
        subAgentId,
        budgetLimitCny,
        autoPlanSubtasks,
        multiAgentPlan,
        autoAdvancePlan,
        planMode: Boolean(planMode),
        actor: "admin",
      });
      reply.code(201);
      return task;
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id", { preHandler: requireAuth }, async (req, reply) => {
    const task = taskManager.getTask(req.params.id);
    if (!task) {
      reply.code(404);
      return { error: "not found" };
    }
    return task;
  });

  app.put<{ Params: { id: string }; Body: RenameTaskBody }>("/api/tasks/:id", { preHandler: requireAuth }, async (req, reply) => {
    const title = req.body?.title?.trim();
    if (!title) {
      reply.code(400);
      return { error: "title 为必填项" };
    }
    try {
      return taskManager.renameTask(req.params.id, title, "admin");
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.put<{ Params: { id: string }; Body: RenameTaskBody }>("/api/tasks/:id/title", { preHandler: requireAuth }, async (req, reply) => {
    const title = req.body?.title?.trim();
    if (!title) {
      reply.code(400);
      return { error: "title 为必填项" };
    }
    try {
      return taskManager.renameTask(req.params.id, title, "admin");
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/messages", { preHandler: requireAuth }, async (req) =>
    taskManager.listMessages(req.params.id)
  );

  app.put<{ Params: { id: string }; Body: ChangeWorkspaceBody }>("/api/tasks/:id/workspace", { preHandler: requireAuth }, async (req, reply) => {
    const workspaceId = req.body?.workspaceId?.trim();
    if (!workspaceId) {
      reply.code(400);
      return { error: "workspaceId 为必填项" };
    }
    try {
      return taskManager.changeTaskWorkspace(req.params.id, workspaceId, Boolean(req.body?.confirmed), "admin");
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/resources", { preHandler: requireAuth }, async (req, reply) => {
    try {
      return taskManager.getTaskResources(req.params.id);
    } catch (err) {
      reply.code(404);
      return { error: (err as Error).message };
    }
  });

  app.put<{ Params: { id: string }; Body: { enabled?: boolean } }>("/api/tasks/:id/plan-mode", { preHandler: requireAuth }, async (req, reply) => {
    try {
      return taskManager.setTaskPlanMode(req.params.id, Boolean(req.body?.enabled), "admin");
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/plan/approve", { preHandler: requireAuth }, async (req, reply) => {
    try {
      return taskManager.approvePlan(req.params.id, "admin");
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/snapshots", { preHandler: requireAuth }, async (req) => {
    return taskManager.listSnapshots(req.params.id);
  });

  app.get<{ Params: { id: string; snapshotId: string } }>(
    "/api/tasks/:id/snapshots/:snapshotId/preview",
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        return await taskManager.previewSnapshotRestore(req.params.id, req.params.snapshotId);
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    }
  );

  app.post<{ Params: { id: string; snapshotId: string } }>(
    "/api/tasks/:id/snapshots/:snapshotId/restore",
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        return await taskManager.restoreSnapshot(req.params.id, req.params.snapshotId, "admin");
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    }
  );

  app.put<{ Params: { id: string }; Body: TaskModelBody }>(
    "/api/tasks/:id/model",
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        return taskManager.setTaskModel(req.params.id, req.body?.model ?? null, "admin");
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    }
  );

  app.put<{ Params: { id: string }; Body: AutoAdvancePlanBody }>(
    "/api/tasks/:id/auto-advance-plan",
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        return taskManager.setAutoAdvancePlan(req.params.id, Boolean(req.body?.enabled), "admin");
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    }
  );

  app.get<{ Params: { id: string } }>("/api/tasks/:id/events", { preHandler: requireAuth }, async (req) =>
    taskManager.listEvents(req.params.id)
  );

  app.get<{ Params: { id: string } }>("/api/tasks/:id/domain-events", { preHandler: requireAuth }, async (req) =>
    taskManager.listDomainEvents(req.params.id)
  );

  app.get<{ Params: { id: string } }>("/api/tasks/:id/flow", { preHandler: requireAuth }, async (req, reply) => {
    const snapshot = taskManager.getFlowSnapshot(req.params.id);
    if (!snapshot) {
      reply.code(404);
      return { error: "not found" };
    }
    return snapshot;
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/subtasks/runnable", { preHandler: requireAuth }, async (req, reply) => {
    try {
      return taskManager.listRunnableSubtasks(req.params.id);
    } catch (err) {
      reply.code(404);
      return { error: (err as Error).message };
    }
  });

  app.post<{ Params: { id: string }; Body: DispatchNextSubtaskBody }>(
    "/api/tasks/:id/subtasks/dispatch-next",
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        return taskManager.dispatchNextSubtask(
          req.params.id,
          {
            agentId: req.body?.agentId ?? null,
            prompt: req.body?.prompt ?? null,
            model: req.body?.model ?? null,
            images: req.body?.images ?? [],
          },
          "admin"
        );
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    }
  );

  app.get<{ Params: { id: string } }>("/api/tasks/:id/files", { preHandler: requireAuth }, async (req) =>
    taskManager.getFiles(req.params.id)
  );

  app.get<{ Params: { id: string } }>("/api/tasks/:id/diff", { preHandler: requireAuth }, async (req) => {
    return { diff: taskManager.getDiff(req.params.id) };
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/approvals", { preHandler: requireAuth }, async (req) =>
    taskManager.listApprovals(req.params.id)
  );

  app.get<{ Params: { id: string } }>("/api/tasks/:id/recovery", { preHandler: requireAuth }, async (req) =>
    taskManager.listRecoveryActions(req.params.id)
  );

  app.get<{ Params: { id: string } }>("/api/tasks/:id/reviews", { preHandler: requireAuth }, async (req) =>
    taskManager.listReviewDecisions(req.params.id)
  );

  app.post<{ Params: { id: string }; Body: SendMessageBody }>(
    "/api/tasks/:id/messages",
    { preHandler: requireAuth },
    async (req, reply) => {
      const message = req.body?.message?.trim();
      const images = req.body?.images ?? [];
      if (!message && images.length === 0) {
        reply.code(400);
        return { error: "message 或图片不能为空" };
      }
      try {
        taskManager.sendMessage(req.params.id, message ?? "", images, "admin");
        return { ok: true };
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    }
  );

  // ---- 任务内消息队列：排队 / 拖拽重排 / 删除，任务自然完成后自动派发下一条 ----
  app.get<{ Params: { id: string } }>("/api/tasks/:id/queue", { preHandler: requireAuth }, async (req) =>
    taskManager.listQueue(req.params.id)
  );

  app.post<{ Params: { id: string }; Body: EnqueueBody }>(
    "/api/tasks/:id/queue",
    { preHandler: requireAuth },
    async (req, reply) => {
      const content = req.body?.content?.trim();
      const images = req.body?.images ?? [];
      if (!content && images.length === 0) {
        reply.code(400);
        return { error: "content 或图片不能为空" };
      }
      try {
        const item = taskManager.enqueueMessage(req.params.id, content ?? "", images, "admin");
        reply.code(201);
        return item;
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    }
  );

  app.delete<{ Params: { id: string; itemId: string } }>(
    "/api/tasks/:id/queue/:itemId",
    { preHandler: requireAuth },
    async (req) => {
      taskManager.removeQueueItem(req.params.id, req.params.itemId, "admin");
      return { ok: true };
    }
  );

  app.put<{ Params: { id: string }; Body: ReorderQueueBody }>(
    "/api/tasks/:id/queue/reorder",
    { preHandler: requireAuth },
    async (req, reply) => {
      const orderedIds = req.body?.orderedIds;
      if (!Array.isArray(orderedIds)) {
        reply.code(400);
        return { error: "orderedIds 必须是数组" };
      }
      return taskManager.reorderQueue(req.params.id, orderedIds, "admin");
    }
  );

  app.post<{ Params: { id: string } }>("/api/tasks/:id/stop", { preHandler: requireAuth }, async (req, reply) => {
    try {
      await taskManager.stopTask(req.params.id, "admin");
      return { ok: true };
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.post<{ Params: { id: string }; Body: RecoveryBody }>("/api/tasks/:id/retry", { preHandler: requireAuth }, async (req, reply) => {
    try {
      return taskManager.retryTask(req.params.id, req.body?.note, "admin");
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.post<{ Params: { id: string }; Body: RecoveryBody }>("/api/tasks/:id/handoff", { preHandler: requireAuth }, async (req, reply) => {
    try {
      return taskManager.handoffToHuman(req.params.id, req.body?.note, "admin");
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.post<{ Params: { id: string }; Body: AgentHandoffBody }>(
    "/api/tasks/:id/agent-handoff",
    { preHandler: requireAuth },
    async (req, reply) => {
      const agentId = req.body?.agentId?.trim();
      const prompt = req.body?.prompt?.trim();
      if (!agentId || !prompt) {
        reply.code(400);
        return { error: "agentId / prompt 为必填项" };
      }
      try {
        taskManager.dispatchAgentHandoff(
          req.params.id,
          {
            agentId,
            prompt,
            subtaskId: req.body?.subtaskId ?? null,
            model: req.body?.model ?? null,
            images: req.body?.images ?? [],
          },
          "admin"
        );
        return { ok: true };
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    }
  );

  app.post<{ Params: { id: string }; Body: ReviewBody }>("/api/tasks/:id/review/approve", { preHandler: requireAuth }, async (req, reply) => {
    try {
      return taskManager.approveTaskReview(req.params.id, req.body?.note, "admin");
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.post<{ Params: { id: string }; Body: ReviewBody }>(
    "/api/tasks/:id/review/request-changes",
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        return taskManager.requestTaskChanges(req.params.id, req.body?.note, "admin");
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    }
  );

  app.delete<{ Params: { id: string } }>("/api/tasks/:id", { preHandler: requireAuth }, async (req, reply) => {
    try {
      taskManager.deleteTask(req.params.id, "admin");
      return { ok: true };
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  // 单个任务的实时事件流：Chat / Events / Terminal / Files / Diff / Approvals 各 tab 共用一条流，
  // 前端按 event.type 分发渲染。
  app.get<{ Params: { id: string } }>("/api/tasks/:id/stream", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params;
    const { send, onClose } = startSSE(req, reply);
    const listener = (event: unknown) => send("task_event", event);
    bus.on(`task:${id}`, listener);
    onClose(() => bus.off(`task:${id}`, listener));
  });

  app.post<{ Params: { approvalId: string }; Body: DecideApprovalBody & { taskId: string } }>(
    "/api/approvals/:approvalId/decide",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { approvalId } = req.params;
      const { taskId, decision, note } = req.body ?? ({} as DecideApprovalBody & { taskId: string });
      if (!taskId || !decision) {
        reply.code(400);
        return { error: "taskId / decision 为必填项" };
      }
      try {
        const approval = taskManager.approveAction(taskId, approvalId, decision, note, "admin");
        return approval;
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    }
  );

  app.get("/api/approvals", { preHandler: requireAuth }, async () => taskManager.listApprovals());

  app.get("/api/approval-rules", { preHandler: requireAuth }, async () => taskManager.listAlwaysAllowRules());

  app.delete<{ Params: { id: string } }>("/api/approval-rules/:id", { preHandler: requireAuth }, async (req, reply) => {
    try {
      taskManager.deleteAlwaysAllowRule(req.params.id, "admin");
      return { ok: true };
    } catch (err) {
      reply.code(404);
      return { error: (err as Error).message };
    }
  });

  // 首页看板的全局实时流：任务状态变化 + 新审批
  app.get("/api/dashboard/stream", { preHandler: requireAuth }, async (req, reply) => {
    const { send, onClose } = startSSE(req, reply);
    const listener = (payload: unknown) => send("dashboard_event", payload);
    bus.on("dashboard", listener);
    onClose(() => bus.off("dashboard", listener));
  });
}
