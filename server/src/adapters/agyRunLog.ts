import fs from "node:fs";
import path from "node:path";

/**
 * Antigravity（agy）不出声的时候在干什么：它的 stream-json 只在模型回了话、调了工具时才输出，
 * 请求模型卡住、失败、自动重试这些全都只写进自己的运行日志（~/.gemini/antigravity-cli/log/cli-<时间>.log），
 * 任务页上就是几十分钟一点动静都没有，看不出是在想还是卡死了。
 *
 * 这里在任务运行期间盯着这一轮的那份日志，把重试的行翻成大白话交给任务输出。只读日志，不碰 agy 本身。
 *
 * 怎么认出哪份日志是这一轮的（agy 1.5.x，2026-11-17 用本机 7 次运行核对过）：每次运行新建一份日志，里面有一行
 *   printmode.go:208] Print mode: starting (promptLength=12450, model="gemini-4-argon-medium", conversationID="c0ffee…")
 * promptLength 是提示词的 UTF-8 字节数，conversationID 是 --conversation 传进去的（新对话为空），
 * 三样都对上才算；同时跑的几个任务、Xgent 查额度用的 agy 都不会认错。
 */

const RETRY_RE = /\] Run: attempt (\d+) failed \((.*)\), retrying in (\S+?)\s*$/;
const START_RE = /Print mode: starting \(promptLength=(\d+), model="([^"]*)", conversationID="([^"]*)"\)/;

/** 「4s」「6.889113149s」「1m2.5s」→「4 秒」「7 秒」「1 分 3 秒」 */
function humanWait(value: string): string {
  const match = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?$/);
  if (!match || !value) return value;
  const total = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Math.round(Number(match[3] ?? 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours} 小时${minutes ? ` ${minutes} 分` : ""}`;
  if (minutes) return `${minutes} 分${seconds ? ` ${seconds} 秒` : ""}`;
  return `${seconds} 秒`;
}

function humanReason(reason: string): string {
  const idle = reason.match(/stream idle timeout \((?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?\)/);
  if (idle) {
    const minutes = Number(idle[1] ?? 0) * 60 + Number(idle[2] ?? 0);
    return minutes ? `模型 ${minutes} 分钟没有回应` : "模型太久没有回应";
  }
  if (/RESOURCE_EXHAUSTED|code 429/i.test(reason)) {
    const resets = reason.match(/Resets in (\S+?)\.?(?:\s|$)/)?.[1];
    return resets ? `这个账号的额度用完了（约 ${humanWait(resets)}后恢复）` : "这个账号的额度不够了，或者请求太频繁";
  }
  if (/UNAVAILABLE|code 503|No capacity/i.test(reason)) return "模型那边太忙，暂时没有空闲算力";
  if (/\bEOF\b|connection reset|ECONNRESET|ECONNREFUSED|dial tcp|TLS handshake|i\/o timeout|no such host|network/i.test(reason)) {
    return "连模型服务器的网络断了";
  }
  const flat = reason.replace(/\s+/g, " ").trim();
  return flat.length > 90 ? `${flat.slice(0, 89)}…` : flat;
}

/** 日志里的一行 → 给人看的一句话；不是重试行就返回 null */
export function explainAgyLogLine(line: string): string | null {
  const retry = line.match(RETRY_RE);
  if (!retry) return null;
  return `第 ${retry[1]} 次请求模型没成功：${humanReason(retry[2]!)}，${humanWait(retry[3]!)}后自动重试`;
}

export interface AgyRunIdentity {
  /** 传给 -p 的提示词 */
  prompt: string;
  /** --conversation 传的对话 ID；新对话为 null */
  conversationId: string | null;
  /** --model 传的模型；没传就不比 */
  model: string | null;
}

/** 这份日志开头那行是不是这一轮的 */
export function isAgyRunLogFor(text: string, identity: AgyRunIdentity): boolean {
  const start = text.match(START_RE);
  if (!start) return false;
  return (
    Number(start[1]) === Buffer.byteLength(identity.prompt, "utf8") &&
    start[3] === (identity.conversationId ?? "") &&
    (!identity.model || start[2] === identity.model)
  );
}

/** 已经被某个正在跑的任务认领的日志，别的任务不再看 */
const claimedLogs = new Set<string>();

function listLogs(logDir: string): string[] {
  try {
    return fs.readdirSync(logDir).filter((name) => /^cli-.*\.log$/.test(name));
  } catch {
    return [];
  }
}

/**
 * 启动 agy 之前调用（先记下已有的日志，新出现的才可能是这一轮的），返回的 stop 在进程结束时调用。
 * 认出这一轮的日志后，每发现一条重试就调用 onNotice。出任何错都静默放弃，不影响任务。
 */
export function watchAgyRunLog(
  logDir: string,
  identity: AgyRunIdentity,
  onNotice: (text: string) => void,
  intervalMs = 5000
): () => void {
  const existing = new Set(listLogs(logDir));
  let file: string | null = null;
  let offset = 0;
  let pending = "";
  const giveUpAt = Date.now() + 2 * 60 * 1000; // 2 分钟还认不出来（agy 换了日志格式）就不找了

  const readNew = () => {
    if (!file) return;
    let fd: number | null = null;
    try {
      fd = fs.openSync(file, "r");
      const size = fs.fstatSync(fd).size;
      if (size <= offset) return;
      const buffer = Buffer.alloc(size - offset);
      fs.readSync(fd, buffer, 0, buffer.length, offset);
      offset = size;
      const lines = (pending + buffer.toString("utf8")).split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const notice = explainAgyLogLine(line);
        if (notice) onNotice(notice);
      }
    } catch {
      // 日志被删、被占用：下次再试
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  };

  const findOwnLog = () => {
    for (const name of listLogs(logDir)) {
      const full = path.join(logDir, name);
      if (existing.has(name) || claimedLogs.has(full)) continue;
      try {
        const head = fs.readFileSync(full, "utf8").slice(0, 256 * 1024);
        if (!head.includes("Print mode: starting")) continue; // 刚建好还没写到这一行：先别排除，下次再看
        existing.add(name); // 看过、不是这一轮的，以后不再读
        if (isAgyRunLogFor(head, identity)) {
          claimedLogs.add(full);
          file = full;
          return;
        }
      } catch {
        // 读不了：下次再看
      }
    }
  };

  const tick = () => {
    if (!file) {
      if (Date.now() > giveUpAt) return;
      findOwnLog();
    }
    readNew();
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    tick(); // 进程结束前最后写的几行也读出来
    if (file) claimedLogs.delete(file);
  };
}
