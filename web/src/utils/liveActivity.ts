/**
 * 任务运行时对话页上的「正在做什么」：把这一轮 Agent 写进终端的输出整理成人能看懂的几步。
 *
 * 各家 Agent 写终端的格式（server/src/adapters 里的 ctx.terminal）：
 *   Antigravity  `$ [antigravity:write_file] {"Path":"…"}`（每个工具开始、结束各报一次）
 *   Claude Code  `$ [tool_use] Write {"file_path":"…"}`
 *   DeepSeek     `$ [read_file] {…}`
 *   Codex / 模拟  `$ npm test`（直接是命令）
 *   启动那一行    `$ agy …` / `$ codex …` / `$ POST https://…`
 *   提醒          `$ [antigravity:notice] 第 1 次请求模型没成功：…`（Xgent 从 agy 日志里读出来的，原样显示、标成提醒色）
 * 不以 `$ ` 开头的是模型边写边吐的文字或命令输出，只取最后一小段当「最新输出」。
 * 只做显示，不影响任务本身。
 */

export interface ActivityStep {
  at: number;
  label: string;
  /** 请求失败、重试这类提醒 */
  warn?: boolean;
}

export interface LiveActivity {
  /** 这一轮 Agent 进程启动的时间（终端里启动那一行），没看到就是 null */
  startedAt: number | null;
  steps: ActivityStep[];
  /** 最后一次有输出的时间（毫秒）；这一轮还没任何输出时为 null */
  lastAt: number | null;
  /** 最新一段非动作输出（模型正在写的文字、命令输出），已压成一行 */
  latestOutput: string | null;
}

interface TerminalEventLike {
  type: string;
  payload?: { chunk?: string } | null;
  createdAt: string;
}

const LAUNCH_NAMES = new Set(["agy", "antigravity", "codex", "claude", "dsh", "openclaw", "arkcli", "codebuddy"]);

/** 启动 Agent 的那一行：程序可能写成完整路径（"C:\…\claude.exe"、C:\…\agy.cmd），按程序名认 */
function isLaunchLine(body: string): boolean {
  if (/^POST\s/i.test(body)) return true;
  const first = body.match(/^"([^"]+)"|^(\S+)/);
  const program = first?.[1] ?? first?.[2] ?? "";
  return LAUNCH_NAMES.has(basename(program).replace(/\.(cmd|exe|ps1|bat|js|mjs)$/i, "").toLowerCase());
}

const VERBS: Record<string, string> = {
  // Antigravity
  read_file: "读取",
  view_file: "读取",
  write_file: "写入",
  write_to_file: "写入",
  edit_file: "修改",
  replace_file_content: "修改",
  multi_replace_file_content: "修改",
  run_command: "运行命令",
  list_dir: "查看目录",
  list_directory: "查看目录",
  grep_search: "搜索",
  find_by_name: "查找文件",
  search_web: "上网搜索",
  read_url_content: "打开网页",
  // Claude Code / CodeBuddy
  read: "读取",
  write: "写入",
  edit: "修改",
  multiedit: "修改",
  notebookedit: "修改",
  bash: "运行命令",
  grep: "搜索",
  glob: "查找文件",
  ls: "查看目录",
  webfetch: "打开网页",
  websearch: "上网搜索",
  task: "派子任务",
  todowrite: "更新待办清单",
};

function basename(value: string): string {
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 从工具参数里挑一个最能说明在干什么的：文件名、命令、搜索词、网址 */
function describeTarget(rawJson: string): string {
  let params: Record<string, unknown> | null = null;
  try {
    params = JSON.parse(rawJson);
  } catch {
    // 被截断或不规范的参数：直接抠文件路径 / 命令
    const loose = rawJson.match(/"(?:path|file_path|filePath|AbsolutePath|TargetFile|CommandLine|command)"\s*:\s*"([^"]+)"/i)?.[1];
    if (loose) return /[\\/]/.test(loose) && !/\s/.test(loose) ? basename(loose) : clip(loose, 70);
    return clip(rawJson, 60);
  }
  if (!params || typeof params !== "object") return "";
  const pick = (...keys: string[]) => {
    for (const key of Object.keys(params!)) {
      if (keys.includes(key.toLowerCase()) && typeof params![key] === "string" && params![key]) return params![key] as string;
    }
    return null;
  };
  const file = pick("path", "file_path", "filepath", "absolutepath", "targetfile", "notebook_path", "directorypath", "searchdirectory");
  if (file) return basename(file);
  const command = pick("commandline", "command", "cmd");
  if (command) return clip(command, 70);
  const query = pick("query", "pattern", "searchpattern", "url", "description", "prompt");
  if (query) return clip(query, 60);
  return "";
}

/** 一行 `$ …` → 一步。返回 null 表示不显示（比如启动 Agent 那一行） */
export function describeActionLine(line: string): string | null {
  const body = line.replace(/^\$\s+/, "").trim();
  if (!body) return null;
  // [agent:tool] {json} / [tool_use] Name {json} / [tool] {json}
  const tagged = body.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (tagged) {
    const tag = tagged[1]!;
    let rest = tagged[2] ?? "";
    let tool = tag.includes(":") ? tag.split(":").pop()! : tag;
    if (tool === "notice") return clip(rest, 120) || null;
    if (tool === "tool_use") {
      const named = rest.match(/^(\S+)\s*(.*)$/);
      tool = named?.[1] ?? "工具";
      rest = named?.[2] ?? "";
    }
    const verb = VERBS[tool.toLowerCase()] ?? `调用 ${tool}`;
    const target = rest.trim().startsWith("{") ? describeTarget(rest.trim()) : clip(rest, 60);
    return target ? `${verb}${verb === "运行命令" ? "：" : " "}${target}` : verb;
  }
  if (isLaunchLine(body)) return null;
  return `运行命令：${clip(body.replace(/\s*<\s*(stdin|prompt)\s*$/, ""), 70)}`;
}

/**
 * 整理 since（这一轮开始的时间）之后的终端输出。
 * 同一个动作连着报两次（Antigravity 开始、结束各一次）只算一步；最多留最近 maxSteps 步。
 */
export function summarizeLiveActivity(events: TerminalEventLike[], since: number, maxSteps = 5): LiveActivity {
  let steps: ActivityStep[] = [];
  let startedAt: number | null = null;
  let lastAt: number | null = null;
  let latestOutput: string | null = null;
  for (const event of events) {
    if (event.type !== "terminal") continue;
    const at = Date.parse(event.createdAt);
    if (!Number.isFinite(at) || at < since) continue;
    const chunk = event.payload?.chunk ?? "";
    if (!chunk.trim()) continue;
    lastAt = at;
    const firstLine = chunk.replace(/^\s+/, "").split(/\r?\n/)[0] ?? "";
    if (firstLine.startsWith("$ ")) {
      if (isLaunchLine(firstLine.slice(2).trim())) {
        // 新的一轮（排队消息接着跑、自动继续）：从这里重新算
        startedAt = at;
        steps = [];
        latestOutput = null;
        continue;
      }
      const label = describeActionLine(firstLine);
      const warn = /^\$\s+\[[^\]]*:notice\]/.test(firstLine);
      if (label && steps[steps.length - 1]?.label !== label) steps.push(warn ? { at, label, warn } : { at, label });
      latestOutput = null; // 动作之后的输出是工具结果，不当成「最新输出」
      continue;
    }
    const flat = `${latestOutput ?? ""}${chunk}`.replace(/\s+/g, " ").trim();
    latestOutput = flat ? (flat.length > 160 ? `…${flat.slice(-159)}` : flat) : null; // 留最新的结尾
  }
  return { startedAt, steps: steps.slice(-maxSteps), lastAt, latestOutput };
}

/** 「3 分 12 秒」「45 秒」 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours} 小时 ${minutes} 分`;
  if (minutes) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}
