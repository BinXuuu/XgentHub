import { nanoid } from "nanoid";
import { db } from "../db/index.ts";
import { getAdapter } from "../adapters/registry.ts";
import { resolveMcpServers } from "./mcpServerService.ts";
import { buildLibraryContext } from "./resourceLibraryService.ts";
import { getKnowledgeEntriesByIds, selectTurnKnowledge } from "./knowledgeService.ts";
import type { AgentKind, ChatStatus, MessageRole } from "../types.ts";

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

interface ChatRow {
  id: string;
  agent_id: string;
  agent_kind: AgentKind;
  title: string;
  model: string | null;
  status: ChatStatus;
  mcp_server_ids: string;
  tool_ids: string;
  skill_ids: string;
  knowledge_ids: string;
  created_at: string;
  updated_at: string;
}

interface ChatMessageRow {
  id: string;
  chat_id: string;
  role: MessageRole;
  content: string;
  images: string;
  created_at: string;
}

export interface ChatConversation {
  id: string;
  agentId: string;
  agentKind: AgentKind;
  title: string;
  model: string | null;
  status: ChatStatus;
  mcpServerIds: string[];
  toolIds: string[];
  skillIds: string[];
  knowledgeIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  role: MessageRole;
  content: string;
  images: string[];
  createdAt: string;
}

function toChat(row: ChatRow): ChatConversation {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentKind: row.agent_kind,
    title: row.title,
    model: row.model ?? null,
    status: row.status ?? "idle",
    mcpServerIds: safeJsonParse(row.mcp_server_ids ?? "[]", []),
    toolIds: safeJsonParse(row.tool_ids ?? "[]", []),
    skillIds: safeJsonParse(row.skill_ids ?? "[]", []),
    knowledgeIds: safeJsonParse(row.knowledge_ids ?? "[]", []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role,
    content: row.content,
    images: JSON.parse(row.images || "[]") as string[],
    createdAt: row.created_at,
  };
}

function insertMessage(chatId: string, role: MessageRole, content: string, images: string[] = []): ChatMessage {
  const now = new Date().toISOString();
  const id = nanoid();
  db.prepare("INSERT INTO chat_messages (id, chat_id, role, content, images, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    chatId,
    role,
    content,
    JSON.stringify(images),
    now
  );
  db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(now, chatId);
  return {
    id,
    chatId,
    role,
    content,
    images,
    createdAt: now,
  };
}

const HISTORY_MAX_MESSAGES = 20;
const HISTORY_MAX_CHARS = 8000;
const HISTORY_ITEM_CHARS = 1500;

/**
 * 聊天的 ask() 是一次性调用，Agent 自己不记得前文，所以每轮把之前的对话带上：
 * 从最新往前取，最多 20 条、约 8000 字，单条过长截断，再按时间顺序排好。
 */
export function formatChatHistory(messages: Pick<ChatMessage, "role" | "content" | "images">[]): string | null {
  const conversation = messages.filter((message) => message.role === "user" || message.role === "agent");
  const picked: string[] = [];
  let used = 0;
  let omitted = false;
  for (let i = conversation.length - 1; i >= 0; i--) {
    const message = conversation[i];
    let text = message.content.trim();
    if (text.length > HISTORY_ITEM_CHARS) text = `${text.slice(0, HISTORY_ITEM_CHARS - 1)}…`;
    if (message.images.length) text = `${text}${text ? " " : ""}[附图 ${message.images.length} 张]`;
    if (!text) continue;
    const line = `${message.role === "user" ? "用户" : "你（Agent）"}：${text}`;
    if (picked.length >= HISTORY_MAX_MESSAGES || (picked.length > 0 && used + line.length > HISTORY_MAX_CHARS)) {
      omitted = true;
      break;
    }
    picked.push(line);
    used += line.length;
  }
  if (picked.length === 0) return null;
  return [
    `以下是这个聊天之前的对话记录（按时间顺序${omitted ? "，更早的已省略" : ""}），用来理解上下文：`,
    ...picked.reverse(),
  ].join("\n\n");
}

// 勾选的 Skill/工具/知识库和之前的对话每轮拼在前面，不进聊天记录。
// 聊天的 Agent 是角色时，角色自带的知识组也按任务同样的规则带上（小组整组、大组挑相关的）。
export function buildChatPrompt(
  chat: Pick<ChatConversation, "skillIds" | "toolIds" | "knowledgeIds">,
  userText: string,
  history: Pick<ChatMessage, "role" | "content" | "images">[] = [],
  roleKnowledgeGroupIds: string[] = []
): string {
  const library = buildLibraryContext(chat, userText);
  const picked = getKnowledgeEntriesByIds(chat.knowledgeIds);
  const pickedIds = new Set(picked.map((entry) => entry.id));
  const knowledge = [...picked, ...selectTurnKnowledge(roleKnowledgeGroupIds, userText).filter((entry) => !pickedIds.has(entry.id))];
  const historyBlock = formatChatHistory(history);
  if (!library && knowledge.length === 0 && !historyBlock) return userText;
  const knowledgeBlock = knowledge.length
    ? [
        "这次对话的知识库资料（参考用，优先级低于用户本轮消息）：",
        ...knowledge.map((entry, index) => `${index + 1}. ${entry.title}\n${entry.content}`),
      ].join("\n\n")
    : null;
  return [library, knowledgeBlock, historyBlock, "用户本轮消息：", userText].filter(Boolean).join("\n\n");
}

function setChatStatus(chatId: string, status: ChatStatus): void {
  const now = new Date().toISOString();
  db.prepare("UPDATE chats SET status = ?, updated_at = ? WHERE id = ?").run(status, now, chatId);
}

export const chatService = {
  listChats(): ChatConversation[] {
    return (db.prepare("SELECT * FROM chats ORDER BY updated_at DESC").all() as unknown as ChatRow[]).map(toChat);
  },

  getChat(id: string): ChatConversation | null {
    const row = db.prepare("SELECT * FROM chats WHERE id = ?").get(id) as ChatRow | undefined;
    return row ? toChat(row) : null;
  },

  createChat(input: { agentId: string; title: string; model?: string | null; mcpServerIds?: string[] }): ChatConversation {
    const agent = getAdapter(input.agentId);
    if (!agent) throw new Error("找不到这个 Agent");
    if (!agent.isConfigured()) throw new Error("这个 Agent 还没有配置好");
    const title = input.title.trim();
    if (!title) throw new Error("聊天名称为必填项");
    const role = agent.roleInfo ?? null;
    const model = input.model?.trim() || role?.model || null;
    const mcpServerIds = [...new Set(input.mcpServerIds ?? role?.mcpServerIds ?? [])];
    const now = new Date().toISOString();
    const id = nanoid();
    db.prepare(
      "INSERT INTO chats (id, agent_id, agent_kind, title, model, status, mcp_server_ids, tool_ids, skill_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      id,
      input.agentId,
      agent.kind,
      title,
      model,
      "idle",
      JSON.stringify(mcpServerIds),
      JSON.stringify(role?.toolIds ?? []),
      JSON.stringify(role?.skillIds ?? []),
      now,
      now
    );
    return this.getChat(id)!;
  },

  renameChat(id: string, title: string): ChatConversation {
    const trimmed = title.trim();
    if (!trimmed) throw new Error("聊天名称为必填项");
    const chat = this.getChat(id);
    if (!chat) throw new Error("找不到这个聊天");
    const now = new Date().toISOString();
    db.prepare("UPDATE chats SET title = ?, updated_at = ? WHERE id = ?").run(trimmed, now, id);
    return { ...chat, title: trimmed, updatedAt: now };
  },

  updateChatModel(id: string, model: string | null): ChatConversation {
    const chat = this.getChat(id);
    if (!chat) throw new Error("找不到这个聊天");
    const normalized = model?.trim() || null;
    const now = new Date().toISOString();
    db.prepare("UPDATE chats SET model = ?, updated_at = ? WHERE id = ?").run(normalized, now, id);
    return { ...chat, model: normalized, updatedAt: now };
  },

  setChatMcpServers(id: string, mcpServerIds: string[]): ChatConversation {
    const chat = this.getChat(id);
    if (!chat) throw new Error("找不到这个聊天");
    const deduped = [...new Set(mcpServerIds)];
    const now = new Date().toISOString();
    db.prepare("UPDATE chats SET mcp_server_ids = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(deduped), now, id);
    return { ...chat, mcpServerIds: deduped, updatedAt: now };
  },

  setChatTools(id: string, toolIds: string[]): ChatConversation {
    const chat = this.getChat(id);
    if (!chat) throw new Error("找不到这个聊天");
    const deduped = [...new Set(toolIds)];
    const now = new Date().toISOString();
    db.prepare("UPDATE chats SET tool_ids = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(deduped), now, id);
    return { ...chat, toolIds: deduped, updatedAt: now };
  },

  setChatSkills(id: string, skillIds: string[]): ChatConversation {
    const chat = this.getChat(id);
    if (!chat) throw new Error("找不到这个聊天");
    const deduped = [...new Set(skillIds)];
    const now = new Date().toISOString();
    db.prepare("UPDATE chats SET skill_ids = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(deduped), now, id);
    return { ...chat, skillIds: deduped, updatedAt: now };
  },

  setChatKnowledge(id: string, knowledgeIds: string[]): ChatConversation {
    const chat = this.getChat(id);
    if (!chat) throw new Error("找不到这个聊天");
    const deduped = [...new Set(knowledgeIds)];
    const now = new Date().toISOString();
    db.prepare("UPDATE chats SET knowledge_ids = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(deduped), now, id);
    return { ...chat, knowledgeIds: deduped, updatedAt: now };
  },

  updateChatAgent(id: string, agentId: string): ChatConversation {
    const chat = this.getChat(id);
    if (!chat) throw new Error("找不到这个聊天");
    const agent = getAdapter(agentId);
    if (!agent) throw new Error("找不到这个 Agent");
    if (!agent.isConfigured()) throw new Error("这个 Agent 还没有配置好");
    const now = new Date().toISOString();
    db.prepare("UPDATE chats SET agent_id = ?, agent_kind = ?, model = NULL, updated_at = ? WHERE id = ?").run(agentId, agent.kind, now, id);
    return { ...chat, agentId, agentKind: agent.kind, model: null, updatedAt: now };
  },

  deleteChat(id: string): void {
    const result = db.prepare("DELETE FROM chats WHERE id = ?").run(id);
    if (result.changes === 0) throw new Error("找不到这个聊天");
  },

  listMessages(chatId: string): ChatMessage[] {
    return (db.prepare("SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY created_at ASC").all(chatId) as unknown as ChatMessageRow[]).map(
      toMessage
    );
  },

  async sendMessage(chatId: string, content: string, images: string[] = []): Promise<{ userMessage: ChatMessage; agentMessage: ChatMessage }> {
    const chat = this.getChat(chatId);
    if (!chat) throw new Error("找不到这个聊天");
    if (chat.status === "running") throw new Error("Agent 正在回复，请等这一轮完成后再发送");
    const text = content.trim();
    if (!text && images.length === 0) throw new Error("消息或图片不能为空");
    const agent = getAdapter(chat.agentId);
    if (!agent) throw new Error("找不到这个 Agent");
    if (!agent.isConfigured()) throw new Error("这个 Agent 还没有配置好");
    if (!agent.ask) throw new Error("这个 Agent 暂不支持纯聊天");

    const history = this.listMessages(chatId);
    const userMessage = insertMessage(chatId, "user", text, images);
    let answer: string | null = null;
    const imageNote = images.length > 0 ? `\n\n图片附件路径：\n${images.map((image, index) => `${index + 1}. ${image}`).join("\n")}` : "";
    const mcpServers = resolveMcpServers(chat.mcpServerIds);
    setChatStatus(chatId, "running");
    try {
      answer = await agent.ask(buildChatPrompt(chat, `${text || "请查看图片附件。"}${imageNote}`, history, agent.roleInfo?.knowledgeGroupIds ?? []), { model: chat.model, mcpServers });
      const agentMessage = insertMessage(chatId, "agent", answer?.trim() || "没有返回内容");
      setChatStatus(chatId, "idle");
      return { userMessage, agentMessage };
    } catch (err) {
      answer = `调用失败：${(err as Error).message}`;
      const agentMessage = insertMessage(chatId, "agent", answer);
      setChatStatus(chatId, "failed");
      return { userMessage, agentMessage };
    }
  },
};
