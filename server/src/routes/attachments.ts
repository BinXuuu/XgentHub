import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import { requireAuth } from "../auth.ts";
import { getAttachment, saveAttachment } from "../services/attachmentService.ts";

interface UploadAttachmentBody {
  filename: string;
  dataBase64: string;
}

export function registerAttachmentRoutes(app: FastifyInstance) {
  // 组装消息时上传图片（新建任务还没有 taskId、或还没发送的草稿都能用），返回本机绝对路径，
  // 之后随 createTask/sendMessage/enqueue 一起把路径传给 adapter。
  app.post<{ Body: UploadAttachmentBody }>("/api/attachments", { preHandler: requireAuth }, async (req, reply) => {
    const { filename, dataBase64 } = req.body ?? ({} as UploadAttachmentBody);
    if (!filename || !dataBase64) {
      reply.code(400);
      return { error: "filename / dataBase64 为必填项" };
    }
    try {
      const path = saveAttachment(filename, dataBase64);
      reply.code(201);
      return { path };
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.get<{ Querystring: { path?: string } }>("/api/attachments/file", { preHandler: requireAuth }, async (req, reply) => {
    const filePath = req.query.path;
    if (!filePath) {
      reply.code(400);
      return { error: "path 为必填项" };
    }
    try {
      const attachment = getAttachment(filePath);
      return reply.type(attachment.contentType).send(fs.createReadStream(attachment.path));
    } catch (err) {
      reply.code(404);
      return { error: (err as Error).message };
    }
  });
}
