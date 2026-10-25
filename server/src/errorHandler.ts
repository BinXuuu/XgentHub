import type { FastifyError, FastifyInstance } from "fastify";

// 统一接口的错误返回：前端只认 { error: "..." }。
// 以前没捕获的错误走 Fastify 默认格式，error 字段固定是 "Internal Server Error"，
// 业务里 throw 的中文提示（比如"已经有叫「工作号」的账号了"）根本到不了用户眼前，状态码也全是 500。
//
// 分三类：
// - Fastify 自己带状态码的（JSON 写错、请求体太大等）：照原状态码；
// - 程序 bug（TypeError、ReferenceError 等）和系统错误（带 code 的文件/数据库错误）：500，记日志；
// - 其余业务代码主动 throw new Error("...")：都是"这个请求不行"的提示，400。
const PROGRAMMING_ERRORS = new Set(["TypeError", "ReferenceError", "SyntaxError", "RangeError"]);

export function classifyError(err: FastifyError | Error): { status: number; message: string; internal: boolean } {
  const statusCode = (err as FastifyError).statusCode;
  if (typeof statusCode === "number" && statusCode >= 400) {
    return { status: statusCode, message: err.message, internal: statusCode >= 500 };
  }
  if (PROGRAMMING_ERRORS.has(err.name) || (err as NodeJS.ErrnoException).code) {
    return { status: 500, message: `服务器内部错误：${err.message}`, internal: true };
  }
  return { status: 400, message: err.message || "请求没有成功", internal: false };
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    const { status, message, internal } = classifyError(err as FastifyError);
    if (internal) req.log.error({ err }, "request failed");
    reply.code(status).send({ error: message });
  });
}
