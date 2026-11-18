import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.ts";
import { getOnboardingOverview } from "../services/onboardingService.ts";

export function registerOnboardingRoutes(app: FastifyInstance) {
  app.get("/api/onboarding/overview", { preHandler: requireAuth }, async () => {
    return getOnboardingOverview();
  });
}
