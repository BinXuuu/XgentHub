import type { FastifyReply, FastifyRequest } from "fastify";

// 通用 SSE 帮助函数：接管 reply，写响应头，返回一个 send(event, data) 方法，
// 并在客户端断开时自动清理监听器。
export function startSSE(req: FastifyRequest, reply: FastifyReply): { send: (event: string, data: unknown) => void; onClose: (fn: () => void) => void } {
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  reply.raw.write(": connected\n\n");

  const heartbeat = setInterval(() => {
    reply.raw.write(": ping\n\n");
  }, 25000);

  const closeHandlers: (() => void)[] = [];
  req.raw.on("close", () => {
    clearInterval(heartbeat);
    for (const fn of closeHandlers) fn();
  });

  return {
    send: (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    },
    onClose: (fn: () => void) => closeHandlers.push(fn),
  };
}
