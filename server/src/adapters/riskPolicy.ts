import type { PermissionMode, RiskLevel } from "../types.ts";

// 面向“外部自治 agent”类 adapter（OpenClaw / Codex / Claude Code / Hermes）的启发式风险扫描。
// （Claude Code 在「请求批准」「帮我批准」下已经能逐个工具调用进审批，见 claudeCode.ts；这里也用来给那些审批标风险。）
// 这些 adapter 是把整段 prompt/message 交给外部进程/服务自行决策执行，AgentHub 无法拦截其内部
// 每一次工具调用；因此这里在“派发前”对输入文本做风险扫描，命中高风险模式时先进入审批队列，
// 由用户确认后才真正把消息发给外部 agent。这是尽力而为的前置闸门，不等同于逐命令沙箱拦截，
// 在 README 中会说明这一限制以及 Codex App Server 等未来可做逐命令拦截的扩展点。

interface RiskPattern {
  pattern: RegExp;
  riskLevel: RiskLevel;
  reason: string;
}

const PATTERNS: RiskPattern[] = [
  { pattern: /\brm\s+-rf\b|\bdel\s+\/s\b|\bformat\s+[a-z]:/i, riskLevel: "high", reason: "包含批量/强制删除类命令" },
  { pattern: /\bgit\s+push\b/i, riskLevel: "medium", reason: "包含 git push（会推送到远端仓库）" },
  { pattern: /\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-f/i, riskLevel: "high", reason: "包含可能丢弃工作区改动的 git 命令" },
  { pattern: /\bsudo\b/i, riskLevel: "high", reason: "包含 sudo 提权命令" },
  { pattern: /\b(npm|pnpm|yarn)\s+(i|install)\s+-g\b|\bpip\s+install\b|\bchoco\s+install\b|\bwinget\s+install\b/i, riskLevel: "medium", reason: "包含全局/系统级安装命令" },
  { pattern: /curl[^\n]*\|\s*(sh|bash)\b/i, riskLevel: "high", reason: "包含“下载后直接执行”的命令" },
  { pattern: /\.ssh\/|id_rsa|\.env\b|secrets?\.json|credentials/i, riskLevel: "medium", reason: "涉及密钥/凭证相关文件" },
  { pattern: /\bdrop\s+table\b|\btruncate\s+table\b/i, riskLevel: "high", reason: "包含数据库破坏性 SQL" },
  { pattern: /chmod\s+777/i, riskLevel: "medium", reason: "包含放宽文件权限的命令" },
];

export function scanRisk(text: string): { riskLevel: RiskLevel; reason: string } | null {
  for (const p of PATTERNS) {
    if (p.pattern.test(text)) {
      return { riskLevel: p.riskLevel, reason: p.reason };
    }
  }
  return null;
}

/**
 * 建任务时选的权限等级决定扫到风险后要不要真的拦：
 * supervised（请求批准，默认）—— 扫到任何风险都拦；
 * auto（帮我批准）—— 只拦高风险，中低风险放行（对应 Codex 的 --approve-for-me）；
 * full（完全访问权限）—— 完全不拦，非常危险，UI 上要给足警示。
 */
export function shouldGate(riskLevel: RiskLevel, mode: PermissionMode): boolean {
  if (mode === "full") return false;
  if (mode === "auto") return riskLevel === "high";
  return true;
}
