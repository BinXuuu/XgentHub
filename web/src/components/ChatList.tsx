import { useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { copyText } from "../utils/clipboard";
import type { ChatConversation } from "../api/types";
import { useRowMenu } from "./useRowMenu";

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(diffMs / 1000));
  if (s < 60) return `${s}s 前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m 前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h 前`;
  return `${Math.floor(h / 24)}d 前`;
}

interface Props {
  chats: ChatConversation[];
  selectedChatId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onChanged: () => void;
  onDeleted: (id: string) => void;
}

export function ChatList({ chats, selectedChatId, onSelect, onNewChat, onChanged, onDeleted }: Props) {
  const [keyword, setKeyword] = useState("");
  const [agentFilter, setAgentFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [busyChatId, setBusyChatId] = useState<string | null>(null);
  const { openMenuId, menuStyle, toggleMenu, closeMenu } = useRowMenu();
  const [rowMessage, setRowMessage] = useState<{ id: string; text: string } | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const skipBlurSaveRef = useRef(false);
  const busyChatRef = useRef<string | null>(null);
  const normalizedKeyword = keyword.trim().toLocaleLowerCase();
  const agentOptions = useMemo(() => {
    const seen = new Set<string>();
    return chats
      .filter((chat) => {
        const key = chat.agentId || chat.agentKind;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((chat) => ({
        value: chat.agentId || chat.agentKind,
        label: chat.agentId || chat.agentKind,
      }));
  }, [chats]);
  const filteredChats = useMemo(() => {
    return chats.filter((chat) => {
      const agentKey = chat.agentId || chat.agentKind;
      const matchesAgent = agentFilter === "all" || agentKey === agentFilter;
      const matchesStatus = statusFilter === "all" || chat.status === statusFilter;
      const searchText = [chat.title, chat.agentId, chat.agentKind, chat.status].join(" ").toLocaleLowerCase();
      return matchesAgent && matchesStatus && (!normalizedKeyword || searchText.includes(normalizedKeyword));
    });
  }, [agentFilter, chats, normalizedKeyword, statusFilter]);

  function beginRename(chat: ChatConversation) {
    setEditingChatId(chat.id);
    setTitleDraft(chat.title);
    closeMenu();
    setRowMessage(null);
    window.setTimeout(() => {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }, 0);
  }

  function cancelRename() {
    skipBlurSaveRef.current = true;
    setEditingChatId(null);
    setTitleDraft("");
    setRowMessage(null);
  }

  async function saveRowTitle(chat: ChatConversation) {
    if (busyChatRef.current) return;
    const nextTitle = titleDraft.trim();
    if (!nextTitle) {
      setRowMessage({ id: chat.id, text: "聊天名称不能为空" });
      window.setTimeout(() => titleInputRef.current?.focus(), 0);
      return;
    }
    if (nextTitle === chat.title) {
      setEditingChatId(null);
      setRowMessage(null);
      return;
    }
    busyChatRef.current = chat.id;
    setBusyChatId(chat.id);
    setRowMessage(null);
    try {
      await api.renameChat(chat.id, nextTitle);
      setEditingChatId(null);
      setTitleDraft("");
      onChanged();
    } catch (err) {
      setRowMessage({ id: chat.id, text: err instanceof ApiError ? err.message : "改名失败" });
      window.setTimeout(() => titleInputRef.current?.focus(), 0);
    } finally {
      busyChatRef.current = null;
      setBusyChatId(null);
    }
  }

  async function copyChatId(chat: ChatConversation) {
    closeMenu();
    try {
      if (!(await copyText(chat.id))) throw new Error("copy failed");
      setRowMessage({ id: chat.id, text: "已复制 ID" });
      window.setTimeout(() => setRowMessage((current) => (current?.id === chat.id ? null : current)), 1600);
    } catch {
      setRowMessage({ id: chat.id, text: "复制失败" });
    }
  }

  async function removeChat(chat: ChatConversation) {
    closeMenu();
    if (!window.confirm(`删除聊天「${chat.title}」？`)) return;
    busyChatRef.current = chat.id;
    setBusyChatId(chat.id);
    setRowMessage(null);
    try {
      await api.deleteChat(chat.id);
      onDeleted(chat.id);
    } catch (err) {
      setRowMessage({ id: chat.id, text: err instanceof ApiError ? err.message : "删除失败" });
    } finally {
      busyChatRef.current = null;
      setBusyChatId(null);
    }
  }

  return (
    <div className="task-list-pane chat-list-pane">
      <div className="task-list-head">
        <div>
          <strong>聊天</strong>
          <span>{chats.length} 个</span>
        </div>
        <button className="btn btn-primary btn-sm" type="button" onClick={onNewChat}>
          + 新建聊天
        </button>
      </div>
      <div className="list-tools chat-list-tools">
        <label className="list-select-wrap">
          <span className="sr-only">按 Agent 筛选聊天</span>
          <select className="list-select" value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)}>
            <option value="all">全部 Agent</option>
            {agentOptions.map((agent) => (
              <option key={agent.value} value={agent.value}>
                {agent.label}
              </option>
            ))}
          </select>
        </label>
        <label className="list-select-wrap list-select-wrap-sm">
          <span className="sr-only">按状态筛选聊天</span>
          <select className="list-select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="all">全部状态</option>
            <option value="idle">空闲</option>
            <option value="running">回复中</option>
            <option value="failed">失败</option>
          </select>
        </label>
        <label className="list-search">
          <span className="sr-only">查找聊天</span>
          <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="查找聊天关键词" />
        </label>
      </div>
      <div className="task-list chat-session-list">
        {filteredChats.length === 0 && (
          <div className="empty-state">
            {chats.length === 0 ? "这里还没有聊天，点击上方“新建聊天”开始" : "没有匹配的聊天"}
          </div>
        )}
        {filteredChats.map((chat) => (
          <div
            key={chat.id}
            className={`task-row chat-row ${chat.id === selectedChatId ? "selected" : ""} ${chat.status === "running" ? "running" : ""}`}
            onClick={() => {
              closeMenu();
              onSelect(chat.id);
            }}
          >
            <div className="row-top">
              <span className="agent-chip">{chat.agentKind}</span>
              {editingChatId === chat.id ? (
                <input
                  ref={titleInputRef}
                  className="task-row-title-input chat-row-title-input"
                  value={titleDraft}
                  disabled={busyChatId === chat.id}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  onBlur={() => {
                    if (skipBlurSaveRef.current) {
                      skipBlurSaveRef.current = false;
                      return;
                    }
                    void saveRowTitle(chat);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void saveRowTitle(chat);
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      cancelRename();
                    }
                  }}
                  aria-label="聊天名称"
                />
              ) : (
                <span
                  className="title"
                  title={`${chat.title}（双击重命名）`}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    beginRename(chat);
                  }}
                >
                  {chat.title}
                </span>
              )}
              {chat.status === "running" && <span className="chat-row-status">回复中</span>}
              {chat.status === "failed" && <span className="chat-row-status failed">失败</span>}
            </div>
            <div className="sub">
              <span>{chat.agentId}</span>
              <span>{timeAgo(chat.updatedAt)}</span>
            </div>
            {rowMessage?.id === chat.id && <span className="task-row-inline-message">{rowMessage.text}</span>}
            <div className="task-row-actions" onClick={(event) => event.stopPropagation()}>
              <button
                className="task-row-more-button"
                type="button"
                aria-label="聊天操作"
                onClick={(event) => toggleMenu(chat.id, event)}
              >
                ...
              </button>
              {openMenuId === chat.id && (
                <div className="task-row-menu" style={menuStyle}>
                  <button type="button" onClick={() => beginRename(chat)}>
                    重命名
                  </button>
                  <button type="button" onClick={() => void copyChatId(chat)}>
                    复制 ID
                  </button>
                  <button type="button" className="danger" disabled={busyChatId === chat.id} onClick={() => void removeChat(chat)}>
                    删除
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
