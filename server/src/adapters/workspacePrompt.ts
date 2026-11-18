import type { KnowledgeEntry } from "../types.ts";

function formatKnowledge(entries: KnowledgeEntry[]): string | null {
  const normalized = entries
    .map((entry) => ({
      ...entry,
      title: entry.title.trim(),
      content: entry.content.trim(),
      tags: entry.tags.map((tag) => tag.trim()).filter(Boolean),
    }))
    .filter((entry) => entry.title && entry.content)
    .slice(0, 40);
  if (normalized.length === 0) return null;
  return normalized
    .map((entry, index) => {
      const tags = entry.tags.length ? ` 标签：${entry.tags.join(", ")}` : "";
      return `${index + 1}. ${entry.title}${tags}\n${entry.content}`;
    })
    .join("\n\n");
}

export function buildWorkspacePrompt(
  workspacePath: string,
  userText: string,
  workspacePrompt?: string | null,
  workspaceKnowledge: KnowledgeEntry[] = [],
  images: string[] = [],
  workspaceAccessPaths: string[] = []
): string {
  const context = workspacePrompt?.trim();
  const knowledge = formatKnowledge(workspaceKnowledge);
  const imageList = images.map((image, index) => `${index + 1}. ${image}`).join("\n");
  const accessPaths = Array.from(new Set([workspacePath, ...workspaceAccessPaths].map((item) => item.trim()).filter(Boolean)));
  return [
    "Xgent Hub 已为本次任务指定本机工作区。",
    `工作区根目录：${workspacePath}`,
    accessPaths.length > 1
      ? `允许访问空间：\n${accessPaths.map((item) => `- ${item}`).join("\n")}\n这些路径是用户为本工作区配置的可读写区域。需要备份、复制或读取外部项目资料时，可以优先使用这些路径；如果底层 CLI 沙箱仍然拒绝访问，请如实说明需要用户在对应 CLI 或系统侧放行。`
      : null,
    "请把这个路径当作当前项目根目录；需要读写文件或执行命令时，优先在这个目录内操作。",
    "不要再询问用户当前目录在哪里，除非这个路径无法访问或权限不足。",
    imageList ? "" : null,
    imageList ? "本轮用户附带了图片附件。图片已通过多模态通道发送；如果你没有直接看到图片，请读取下面的本机文件路径作为兜底：" : null,
    imageList,
    context ? "" : null,
    context ? "工作区长期上下文 / 约束：" : null,
    context,
    knowledge ? "" : null,
    knowledge ? "工作区相关知识库资料（项目资料，优先级低于用户本轮任务）：": null,
    knowledge,
    "",
    "用户任务：",
    userText,
  ]
    .filter((part): part is string => part != null)
    .join("\n");
}
