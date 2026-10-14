import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.ts";
import {
  getGatewayCloudAccountStatus,
  getGatewayOverview,
  getGatewayTaskUsage,
  updateGatewayBillingSettings,
  type GatewayBillingSettings,
} from "../services/gatewayBillingService.ts";

interface UpdateGatewaySettingsBody {
  settings?: Partial<GatewayBillingSettings>;
}

export function registerGatewayRoutes(app: FastifyInstance) {
  app.get("/api/gateway/official/overview", { preHandler: requireAuth }, async () => getGatewayOverview());

  app.get<{ Params: { taskId: string } }>("/api/gateway/official/tasks/:taskId/usage", { preHandler: requireAuth }, async (req) =>
    getGatewayTaskUsage(req.params.taskId)
  );

  app.get("/api/gateway/official/cloud-account", { preHandler: requireAuth }, async () => getGatewayCloudAccountStatus());

  app.put<{ Body: UpdateGatewaySettingsBody }>("/api/gateway/official/settings", { preHandler: requireAuth }, async (req) => {
    updateGatewayBillingSettings(req.body?.settings ?? {});
    return getGatewayOverview();
  });
}
