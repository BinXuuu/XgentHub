import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.ts";
import {
  applyMachineConfig,
  exportSafeConfig,
  getMachineConfigDiscovery,
  getShortcutStatus,
  getPostInstallStatus,
  getRemoteAccessStatus,
  getStartupTaskStatus,
  importConfig,
  installShortcuts,
  installStartupTask,
  openSystemPath,
  pickConfigBundle,
  requestSafeRestart,
  runDoctor,
  uninstallShortcuts,
  uninstallStartupTask,
} from "../services/systemService.ts";
import type { ConfigImportInput, MachineConfigApplyInput, SystemPathInput } from "../types.ts";
import { checkForUpdate, readUpdateStatus, startUpdate } from "../services/updateService.ts";

export function registerSystemRoutes(app: FastifyInstance) {
  // 在线更新：查新版本（?force=1 跳过 6 小时缓存）、开始更新、看更新进度（服务重启前后都能读到）。
  app.get<{ Querystring: { force?: string } }>("/api/system/update", { preHandler: requireAuth }, async (request) => {
    return checkForUpdate(request.query.force === "1");
  });
  app.post("/api/system/update", { preHandler: requireAuth }, async (_request, reply) => {
    try {
      return await startUpdate();
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });
  app.get("/api/system/update/status", { preHandler: requireAuth }, async () => {
    return readUpdateStatus() ?? { state: "idle" };
  });

  app.post("/api/system/doctor", { preHandler: requireAuth }, async () => {
    return runDoctor();
  });

  app.post("/api/system/config-export", { preHandler: requireAuth }, async () => {
    return exportSafeConfig();
  });

  app.post("/api/system/config-import", { preHandler: requireAuth }, async (request) => {
    return importConfig((request.body ?? {}) as ConfigImportInput);
  });

  app.post("/api/system/config-pick-bundle", { preHandler: requireAuth }, async () => {
    return pickConfigBundle();
  });

  app.get("/api/system/machine-config-discovery", { preHandler: requireAuth }, async () => {
    return getMachineConfigDiscovery();
  });

  app.post("/api/system/machine-config-apply", { preHandler: requireAuth }, async (request) => {
    return applyMachineConfig((request.body ?? {}) as MachineConfigApplyInput);
  });

  app.get("/api/system/post-install", { preHandler: requireAuth }, async () => {
    return getPostInstallStatus();
  });

  app.get("/api/system/remote-access", { preHandler: requireAuth }, async () => {
    return getRemoteAccessStatus();
  });

  app.post("/api/system/restart", { preHandler: requireAuth }, async () => {
    return requestSafeRestart();
  });

  app.post("/api/system/open-path", { preHandler: requireAuth }, async (request) => {
    return openSystemPath(((request.body ?? {}) as SystemPathInput).kind);
  });

  app.get("/api/system/startup-task", { preHandler: requireAuth }, async () => {
    return getStartupTaskStatus();
  });

  app.post("/api/system/startup-task", { preHandler: requireAuth }, async () => {
    return installStartupTask();
  });

  app.delete("/api/system/startup-task", { preHandler: requireAuth }, async () => {
    return uninstallStartupTask();
  });

  app.get("/api/system/shortcuts", { preHandler: requireAuth }, async () => {
    return getShortcutStatus();
  });

  app.post("/api/system/shortcuts", { preHandler: requireAuth }, async () => {
    return installShortcuts();
  });

  app.delete("/api/system/shortcuts", { preHandler: requireAuth }, async () => {
    return uninstallShortcuts();
  });
}
