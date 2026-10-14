import { useEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, FormEvent } from "react";
import { ChevronDown, Image, Mic, Paperclip, SendHorizontal } from "lucide-react";
import { api, ApiError } from "../api/client";
import type { AgentDescriptor, ChatConversation, ChatMessage, ModelOption } from "../api/types";
import { ChatKnowledgeTab, McpTab, SkillsTab, ToolsTab } from "./SelectionTabs";
import { RoleMemoryProposals } from "./RoleMemoryProposals";
import { AttachmentButton, AttachmentChips, type AttachmentButtonHandle } from "./AttachmentBar";
import { extractImageFiles } from "../utils/attachments";

/** "正在回复"旁边显示已经等了多久：复杂问题可能要想好几分钟（超时是 10 分钟），让人知道它没卡住。 */
function ChatWaitingChip({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  const elapsed = seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return <span className="agent-meta-chip chat-status-chip status-running">Agent 正在回复…已等 {elapsed}</span>;
}

interface Props {
  chatId: string;
  agents: AgentDescriptor[];
  onBack: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function attachmentUrl(path: string): string {
  return `/api/attachments/file?path=${encodeURIComponent(path)}`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? "图片";
}

export function ChatDetail({ chatId, agents, onBack, onChanged, onDeleted }: Props) {
  const [chat, setChat] = useState<ChatConversation | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [showAgentSwitch, setShowAgentSwitch] = useState(false);
  const [agentDraft, setAgentDraft] = useState("");
  const [savingAgent, setSavingAgent] = useState(false);
  const [showModelSwitch, setShowModelSwitch] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelDraft, setModelDraft] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [tab, setTab] = useState<"chat" | "mcp" | "tools" | "skills" | "knowledge">("chat");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [speechSeconds, setSpeechSeconds] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const skipTitleBlurSaveRef = useRef(false);
  const renamingTitleRef = useRef(false);
  const attachRef = useRef<AttachmentButtonHandle>(null);
  const speechRef = useRef<any>(null);
  const speechBaseRef = useRef("");
  const speechFinalRef = useRef("");
  const agent = useMemo(() => agents.find((item) => item.id === chat?.agentId), [agents, chat?.agentId]);
  const selectedModelLabel = useMemo(() => {
    if (!chat?.model) return "默认模型";
    return models.find((model) => model.id === chat.model)?.label ?? chat.model;
  }, [chat?.model, models]);
  const chatBusy = busy || chat?.status === "running";
  const canSubmit = draft.trim().length > 0 || images.length > 0;

  async function refresh() {
    const [nextChat, nextMessages] = await Promise.all([api.getChat(chatId), api.listChatMessages(chatId)]);
    setChat(nextChat);
    setTitleDraft(nextChat.title);
    setMessages(nextMessages);
  }

  useEffect(() => {
    setError(null);
    setShowAgentSwitch(false);
    setAgentDraft("");
    setShowModelSwitch(false);
    setModels([]);
    setModelDraft("");
    setTab("chat");
    refresh().catch((err) => setError(err instanceof ApiError ? err.message : "加载失败"));
  }, [chatId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length]);

  useEffect(() => {
    if (chat?.status !== "running") return;
    const timer = window.setInterval(() => {
      refresh()
        .then(onChanged)
        .catch((err) => setError(err instanceof ApiError ? err.message : "刷新聊天状态失败"));
    }, 1800);
    return () => window.clearInterval(timer);
  }, [chat?.status, chatId, onChanged]);

  useEffect(() => {
    if (!listening) {
      setSpeechSeconds(0);
      return;
    }
    const timer = window.setInterval(() => setSpeechSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [listening]);

  useEffect(() => {
    return () => {
      speechRef.current?.stop?.();
      speechRef.current = null;
    };
  }, []);

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = extractImageFiles(event);
    if (files.length > 0) {
      event.preventDefault();
      attachRef.current?.handleFiles(files);
    }
  }

  function getSpeechRecognition() {
    return (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
  }

  function speechErrorMessage(error: string | undefined): string {
    if (error === "not-allowed") return "麦克风权限被拒绝，请允许浏览器使用麦克风";
    if (error === "network") return "浏览器在线语音服务不可用，请检查网络/VPN；不影响手动输入";
    if (error === "no-speech") return "没有检测到语音，请靠近麦克风后重试";
    if (error === "audio-capture") return "没有检测到可用麦克风";
    if (error === "aborted") return "语音输入已取消";
    return `语音输入失败：${error ?? "未知错误"}`;
  }

  function stopSpeechInput() {
    speechRef.current?.stop?.();
    speechRef.current = null;
    setListening(false);
  }

  function startSpeechInput() {
    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition) {
      setSpeechError("当前浏览器不支持语音输入");
      alert("当前浏览器不支持语音输入。建议用 Chrome / Edge，或后续接入本地 Whisper。");
      return;
    }
    setSpeechError(null);
    speechRef.current?.stop?.();
    const recognition = new SpeechRecognition();
    speechRef.current = recognition;
    speechBaseRef.current = draft.trim();
    speechFinalRef.current = "";
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event: any) => {
      let interim = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const transcript = event.results[index]?.[0]?.transcript ?? "";
        if (event.results[index]?.isFinal) speechFinalRef.current += transcript;
        else interim += transcript;
      }
      const next = [speechBaseRef.current, speechFinalRef.current, interim].filter(Boolean).join(" ").trimStart();
      setDraft(next);
    };
    recognition.onerror = (event: any) => {
      setSpeechError(speechErrorMessage(event?.error));
      setListening(false);
    };
    recognition.onend = () => {
      setListening(false);
      speechRef.current = null;
    };
    try {
      recognition.start();
      setListening(true);
    } catch (err) {
      setSpeechError((err as Error).message);
      setListening(false);
    }
  }

  function toggleSpeechInput() {
    if (listening) stopSpeechInput();
    else startSpeechInput();
  }

  function openAgentSwitch() {
    if (!chat) return;
    setShowAgentSwitch(true);
    setShowModelSwitch(false);
    setAgentDraft(chat.agentId);
  }

  async function saveAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!chat || !agentDraft || agentDraft === chat.agentId) {
      setShowAgentSwitch(false);
      return;
    }
    setSavingAgent(true);
    setError(null);
    try {
      const updated = await api.updateChatAgent(chat.id, agentDraft);
      setChat(updated);
      setModels([]);
      setModelDraft("");
      setShowAgentSwitch(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "切换 Agent 失败");
    } finally {
      setSavingAgent(false);
    }
  }

  async function openModelSwitch() {
    if (!chat) return;
    setShowAgentSwitch(false);
    setShowModelSwitch(true);
    setModelDraft(chat.model ?? "");
    if (!agent?.supportsModelSelection) {
      setModels([]);
      return;
    }
    setLoadingModels(true);
    try {
      const nextModels = await api.listModels(chat.agentId, true);
      setModels(nextModels);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "模型列表加载失败");
    } finally {
      setLoadingModels(false);
    }
  }

  async function saveModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!chat) return;
    setSavingModel(true);
    setError(null);
    try {
      const updated = await api.updateChatModel(chat.id, modelDraft || null);
      setChat(updated);
      setShowModelSwitch(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "切换模型失败");
    } finally {
      setSavingModel(false);
    }
  }

  async function saveMcpServers(ids: string[]) {
    const updated = await api.setChatMcpServers(chatId, ids);
    setChat(updated);
    onChanged();
  }

  async function send() {
    const text = draft.trim();
    if ((!text && images.length === 0) || chatBusy) return;
    const sendingImages = images;
    setBusy(true);
    setError(null);
    setChat((current) => (current ? { ...current, status: "running" } : current));
    setDraft("");
    setImages([]);
    const optimisticMessage: ChatMessage = {
      id: `local:${Date.now()}`,
      chatId,
      role: "user",
      content: text,
      images: sendingImages,
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, optimisticMessage]);
    try {
      const request = api.sendChatMessage(chatId, text, sendingImages);
      window.setTimeout(onChanged, 250);
      await request;
      await refresh();
      onChanged();
    } catch (err) {
      setMessages((current) => current.filter((message) => message.id !== optimisticMessage.id));
      setDraft(text);
      setImages(sendingImages);
      setError(err instanceof ApiError ? err.message : "发送失败");
      refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  function openTitleEditor() {
    if (!chat) return;
    setTitleDraft(chat.title);
    setEditingTitle(true);
    window.setTimeout(() => {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }, 0);
  }

  function cancelTitleEditor() {
    skipTitleBlurSaveRef.current = true;
    setEditingTitle(false);
  }

  async function saveTitle() {
    if (!chat || renamingTitleRef.current) return;
    const nextTitle = titleDraft.trim();
    if (!nextTitle || nextTitle === chat.title) {
      setEditingTitle(false);
      return;
    }
    renamingTitleRef.current = true;
    setError(null);
    try {
      const updated = await api.renameChat(chat.id, nextTitle);
      setChat(updated);
      setEditingTitle(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "改名失败");
      window.setTimeout(() => titleInputRef.current?.focus(), 0);
    } finally {
      renamingTitleRef.current = false;
    }
  }

  async function remove() {
    if (!window.confirm("删除这个聊天？")) return;
    setBusy(true);
    try {
      await api.deleteChat(chatId);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "删除失败");
      setBusy(false);
    }
  }

  if (!chat && !error) {
    return <div className="main-area-empty">正在加载聊天...</div>;
  }

  return (
    <div className="detail-pane chat-detail chat-simple-detail">
      <div className="detail-header">
        <div className="title-row">
          <button className="btn btn-ghost btn-sm back-btn" type="button" onClick={onBack}>
            ← 返回
          </button>
          {editingTitle ? (
            <div className="task-title-editor">
              <input
                ref={titleInputRef}
                className="field"
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                onBlur={() => {
                  if (skipTitleBlurSaveRef.current) {
                    skipTitleBlurSaveRef.current = false;
                    return;
                  }
                  void saveTitle();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void saveTitle();
                  }
                  if (event.key === "Escape") {
                    cancelTitleEditor();
                  }
                }}
                aria-label="聊天名称"
              />
            </div>
          ) : (
            <div className="task-title-display">
              <h2 onDoubleClick={openTitleEditor} title="双击重命名">
                {chat?.title ?? "聊天"}
              </h2>
            </div>
          )}
        </div>
        <div className="meta-row">
          <span>聊天</span>
          <span className="agent-meta-chip">
            Agent：{agent?.name ?? chat?.agentId}
            <button className="meta-inline-button" type="button" onClick={openAgentSwitch} disabled={chatBusy}>
              切换
            </button>
          </span>
          <span className="agent-meta-chip">
            模型：{selectedModelLabel}
            <button className="meta-inline-button" type="button" onClick={openModelSwitch} disabled={chatBusy}>
              切换
            </button>
          </span>
          {chat?.status === "running" && <ChatWaitingChip since={chat.updatedAt} />}
          {chat?.status === "failed" && <span className="agent-meta-chip chat-status-chip status-failed">上一轮回复失败</span>}
        </div>
      </div>

      {showAgentSwitch && (
        <form className="workspace-switch-panel model-switch-panel" onSubmit={saveAgent}>
          <div className="workspace-switch-copy">
            <strong>切换 Agent</strong>
            <span>只影响这个聊天后续的新消息，历史对话会保留。</span>
          </div>
          <select className="field" value={agentDraft} onChange={(event) => setAgentDraft(event.target.value)} disabled={savingAgent}>
            {agents
              .filter((item) => item.configured)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({item.kind})
                </option>
              ))}
          </select>
          <button className="btn btn-primary btn-sm" type="submit" disabled={savingAgent || !agentDraft || agentDraft === chat?.agentId}>
            {savingAgent ? "切换中..." : "确认切换"}
          </button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setShowAgentSwitch(false)} disabled={savingAgent}>
            取消
          </button>
        </form>
      )}

      {showModelSwitch && (
        <form className="workspace-switch-panel model-switch-panel" onSubmit={saveModel}>
          <div className="workspace-switch-copy">
            <strong>切换模型</strong>
            <span>只影响这个聊天后续的新消息，历史回复不会重跑。</span>
          </div>
          <div className="model-switch-field">
            <input
              className="field"
              list={`chat-models-${chatId}`}
              value={modelDraft}
              onChange={(event) => setModelDraft(event.target.value)}
              disabled={loadingModels || savingModel}
              placeholder={loadingModels ? "正在加载模型..." : "留空使用默认模型，也可手动输入模型 ID"}
            />
            <datalist id={`chat-models-${chatId}`}>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </datalist>
            <small>{models.length > 0 ? "可从建议里选，也可以手动输入。" : "这个 Agent 暂未提供模型列表，可以手动输入模型 ID。"}</small>
          </div>
          <button className="btn btn-primary btn-sm" type="submit" disabled={savingModel || loadingModels}>
            {savingModel ? "保存中..." : loadingModels ? "加载中..." : "确认切换"}
          </button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setShowModelSwitch(false)} disabled={savingModel}>
            取消
          </button>
        </form>
      )}

      <div className="tabs">
        <div className="tab-strip">
          <button className={`tab-btn ${tab === "chat" ? "active" : ""}`} type="button" onClick={() => setTab("chat")}>
            对话
          </button>
          <button className={`tab-btn ${tab === "mcp" ? "active" : ""}`} type="button" onClick={() => setTab("mcp")}>
            MCP
            {!!chat?.mcpServerIds.length && <span className="badge">{chat.mcpServerIds.length}</span>}
          </button>
          <button className={`tab-btn ${tab === "tools" ? "active" : ""}`} type="button" onClick={() => setTab("tools")}>
            工具
            {!!chat?.toolIds.length && <span className="badge">{chat.toolIds.length}</span>}
          </button>
          <button className={`tab-btn ${tab === "skills" ? "active" : ""}`} type="button" onClick={() => setTab("skills")}>
            Skill
            {!!chat?.skillIds.length && <span className="badge">{chat.skillIds.length}</span>}
          </button>
          <button className={`tab-btn ${tab === "knowledge" ? "active" : ""}`} type="button" onClick={() => setTab("knowledge")}>
            知识库
            {!!chat?.knowledgeIds.length && <span className="badge">{chat.knowledgeIds.length}</span>}
          </button>
        </div>
        <div className="tab-actions">
          <button className="btn btn-ghost btn-sm" type="button" onClick={remove} disabled={chatBusy}>
            删除
          </button>
        </div>
      </div>

      {tab === "mcp" && chat && (
        <div className="tab-content">
          <McpTab
            scope="聊天"
            agentName={agent?.name ?? chat.agentId}
            supportsMcp={Boolean(agent?.supportsMcp)}
            selectedIds={chat.mcpServerIds}
            onSave={saveMcpServers}
          />
        </div>
      )}
      {tab === "tools" && chat && (
        <div className="tab-content">
          <ToolsTab
            scope="聊天"
            selectedIds={chat.toolIds}
            onSave={async (ids) => {
              setChat(await api.setChatTools(chatId, ids));
              onChanged();
            }}
          />
        </div>
      )}
      {tab === "skills" && chat && (
        <div className="tab-content">
          <SkillsTab
            scope="聊天"
            selectedIds={chat.skillIds}
            onSave={async (ids) => {
              setChat(await api.setChatSkills(chatId, ids));
              onChanged();
            }}
          />
        </div>
      )}
      {tab === "knowledge" && chat && (
        <div className="tab-content">
          <ChatKnowledgeTab
            selectedIds={chat.knowledgeIds}
            onSave={async (ids) => {
              setChat(await api.setChatKnowledge(chatId, ids));
              onChanged();
            }}
          />
        </div>
      )}

      <div className="tab-content chat-tab-content chat-simple-tab-content" hidden={tab !== "chat"}>
        <div className="chat-tab-shell">
          <div className="chat-message-stream" ref={scrollRef}>
            {messages.length === 0 && (
              <div className="main-area-empty chat-empty">
                <strong>这个聊天还没有消息</strong>
                <span>直接在下方输入，Agent 会按纯聊天模式回复。</span>
              </div>
            )}
            {messages.map((message) => (
              <div key={message.id} className={`chat-message ${message.role}`}>
                <div className="chat-message-meta">
                  <span>{message.role === "user" ? "你" : "Agent"}</span>
                  <span>{formatTime(message.createdAt)}</span>
                </div>
                <div className="chat-message-bubble">
                  {message.content && <div>{message.content}</div>}
                  {message.images.length > 0 && (
                    <div className="chat-attachments">
                      {message.images.map((image, index) => (
                        <a key={`${image}-${index}`} href={attachmentUrl(image)} target="_blank" rel="noreferrer" title={image}>
                          <img src={attachmentUrl(image)} alt={basename(image)} />
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {chatBusy && <div className="chat-thinking">Agent 正在回复...</div>}
          </div>

          <div className="chat-composer">
            {agent?.role && <RoleMemoryProposals roleId={agent.role.roleId} roleName={agent.name} refreshKey={messages.length} />}
            <AttachmentChips images={images} onChange={setImages} />
            {speechError && <div className="speech-status speech-error">{speechError}</div>}
            {error && <div className="form-error">{error}</div>}
            <div className="chat-input-row chat-composer-frame chat-direct-composer-frame">
              <textarea
                className="field chat-composer-textarea"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onPaste={handlePaste}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    send();
                  }
                }}
                placeholder="输入消息，继续聊天...（可直接粘贴截图）"
              />
              <div className="chat-composer-toolbar">
                <div className="chat-composer-tools">
                  <AttachmentButton
                    ref={attachRef}
                    className="composer-tool-button"
                    title="添加附件（也可以直接把截图粘贴进输入框）"
                    onChange={(uploaded) => setImages((current) => [...current, ...uploaded])}
                  >
                    <Paperclip size={15} strokeWidth={2} />
                    <span>添加附件</span>
                  </AttachmentButton>
                  <button className="btn btn-sm composer-tool-button" type="button" onClick={() => attachRef.current?.openPicker()} title="选择截图图片，或直接粘贴截图">
                    <Image size={15} strokeWidth={2} />
                    <span>截图</span>
                  </button>
                </div>
                <div className="chat-composer-actions">
                  <button
                    className={`btn btn-sm speech-button composer-icon-button ${listening ? "listening" : ""}`}
                    type="button"
                    onClick={toggleSpeechInput}
                    title={listening ? `停止语音输入，已听写 ${speechSeconds}s` : "语音输入，识别结果会填入输入框"}
                  >
                    <Mic size={16} strokeWidth={2.1} />
                  </button>
                  <button className="btn btn-primary composer-send-button" type="button" onClick={send} disabled={chatBusy || !canSubmit}>
                    <SendHorizontal size={15} strokeWidth={2.1} />
                    <span>发送</span>
                  </button>
                  <button className="btn btn-primary composer-send-menu" type="button" onClick={send} disabled={chatBusy || !canSubmit} title="发送">
                    <ChevronDown size={14} strokeWidth={2.4} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
