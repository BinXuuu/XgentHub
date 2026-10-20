import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent } from "react";
import { ChevronDown, Image, ListChecks, Mic, Paperclip, SendHorizontal } from "lucide-react";
import type { QueuedMessage, TaskMessage, TaskStatus, WorkspaceSnapshot } from "../../api/types";
import { api } from "../../api/client";
import { AttachmentButton, AttachmentChips, type AttachmentButtonHandle } from "../AttachmentBar";
import { extractImageFiles } from "../../utils/attachments";
import { QueuePanel } from "./QueuePanel";
import { RoleMemoryProposals } from "../RoleMemoryProposals";
import { alertDialog, confirmDialog, errorDialog, promptDialog } from "../../utils/dialog";
import { AgentText } from "../AgentText";

interface Props {
  taskId: string;
  messages: TaskMessage[];
  queue: QueuedMessage[];
  status: TaskStatus;
  onMessageSent?: () => void;
  planMode: boolean;
  planModeSince: string | null;
  planEnforced: boolean;
  onSetPlanMode: (enabled: boolean) => Promise<void>;
  onApprovePlan: () => Promise<void>;
  role: { roleId: string; name: string } | null;
}

const IMAGE_LINK_RE = /\[[^\]]*]\(([^)]*\.(?:png|jpe?g|gif|webp|bmp)(?:[?#][^)]*)?)\)/gi;
const RAW_IMAGE_PATH_RE = /(file:\/\/\/[^\s)]+?\.(?:png|jpe?g|gif|webp|bmp)(?:[?#][^\s)]*)?|[A-Za-z]:[\\/][^\s)]+?\.(?:png|jpe?g|gif|webp|bmp))/gi;

function normalizeImagePath(raw: string): string | null {
  const value = raw.trim().replace(/^["']|["']$/g, "");
  if (!value) return null;
  try {
    if (value.startsWith("file:///")) {
      const url = new URL(value);
      const decoded = decodeURIComponent(url.pathname);
      return decoded.replace(/^\/([A-Za-z]:)/, "$1");
    }
  } catch {
    return null;
  }
  if (/^[A-Za-z]:[\\/]/.test(value)) return value;
  return null;
}

function extractReturnedImagePaths(content: string): string[] {
  const found = new Set<string>();
  for (const match of content.matchAll(IMAGE_LINK_RE)) {
    const normalized = normalizeImagePath(match[1] ?? "");
    if (normalized) found.add(normalized);
  }
  for (const match of content.matchAll(RAW_IMAGE_PATH_RE)) {
    const normalized = normalizeImagePath(match[1] ?? "");
    if (normalized) found.add(normalized);
  }
  return Array.from(found);
}

function attachmentUrl(path: string): string {
  return `/api/attachments/file?path=${encodeURIComponent(path)}`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? "图片";
}

export function ChatTab({ taskId, messages, queue, status, onMessageSent, planMode, planModeSince, planEnforced, onSetPlanMode, onApprovePlan, role }: Props) {
  const busy = status === "running" || status === "needs_approval";
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const hasAgentReply = Boolean(planModeSince) && messages.some((message) => message.role === "agent" && message.createdAt > planModeSince!);

  const [snapshots, setSnapshots] = useState<WorkspaceSnapshot[]>([]);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const snapshotByMessage = new Map(snapshots.filter((item) => item.messageId).map((item) => [item.messageId!, item]));

  useEffect(() => {
    api
      .listTaskSnapshots(taskId)
      .then(setSnapshots)
      .catch(() => setSnapshots([]));
  }, [taskId, messages.length]);

  async function restoreFrom(snapshot: WorkspaceSnapshot) {
    setRestoringId(snapshot.id);
    try {
      const preview = await api.previewSnapshotRestore(taskId, snapshot.id);
      const total = preview.restore.length + preview.remove.length + preview.recreate.length;
      if (total === 0) {
        void alertDialog("工作区文件和那时一样，没有需要撤回的改动。", { title: "不需要撤回" });
        return;
      }
      const sample = (label: string, files: string[]) =>
        files.length ? `${label} ${files.length} 个：${files.slice(0, 6).join("、")}${files.length > 6 ? " 等" : ""}` : null;
      const intro =
        snapshot.kind === "before_restore"
          ? "把工作区文件恢复到上一次撤回之前的状态？"
          : "把工作区文件回退到这条消息发出之前？这一轮以及之后各轮 Agent 改的文件都会撤销，对话记录保留。";
      const detail = [sample("还原", preview.restore), sample("删除新增的", preview.remove), sample("恢复被删的", preview.recreate)]
        .filter(Boolean)
        .join("\n");
      if (!(await confirmDialog(`${detail}\n\n撤回前的状态会自动保存，之后还能恢复。`, { title: intro, confirmText: "撤回" }))) return;
      await api.restoreSnapshot(taskId, snapshot.id);
      setSnapshots(await api.listTaskSnapshots(taskId));
      onMessageSent?.();
    } catch (err) {
      void errorDialog(err);
    } finally {
      setRestoringId(null);
    }
  }

  async function rememberMessage(content: string) {
    if (!role) return;
    const text = await promptDialog("以后每一轮都会带给它，可以先精简一下。", { title: `存为「${role.name}」的长期记忆`, defaultValue: content.slice(0, 500), confirmText: "保存" });
    if (!text?.trim()) return;
    try {
      await api.addRoleMemory(role.roleId, { content: text.trim(), source: "message", taskId });
      void alertDialog(`已存为「${role.name}」的记忆。`, { tone: "success", title: "已保存" });
    } catch (err) {
      void errorDialog(err);
    }
  }

  async function runPlanAction(action: () => Promise<void>) {
    setPlanBusy(true);
    setPlanError(null);
    try {
      await action();
    } catch (err) {
      setPlanError((err as Error).message);
    } finally {
      setPlanBusy(false);
    }
  }
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [speechSeconds, setSpeechSeconds] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const attachRef = useRef<AttachmentButtonHandle>(null);
  const speechRef = useRef<any>(null);
  const speechBaseRef = useRef("");
  const speechFinalRef = useRef("");
  const canSubmit = text.trim().length > 0 || images.length > 0;

  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = extractImageFiles(e);
    if (files.length > 0) {
      e.preventDefault(); // 是图片就别把它当文本粘进输入框
      attachRef.current?.handleFiles(files);
    }
  }

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }, [messages.length, status]);

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
      void alertDialog("当前浏览器不支持语音输入。建议用 Chrome / Edge，或后续接入本地 Whisper。", { title: "用不了语音输入" });
      return;
    }
    setSpeechError(null);
    speechRef.current?.stop?.();
    const recognition = new SpeechRecognition();
    speechRef.current = recognition;
    speechBaseRef.current = text.trim();
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
      setText(next);
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

  async function send() {
    if (!canSubmit || sending) return;
    setSending(true);
    try {
      await api.sendMessage(taskId, text.trim(), images);
      setText("");
      setImages([]);
      onMessageSent?.();
    } catch (err) {
      void errorDialog(err);
    } finally {
      setSending(false);
    }
  }

  async function addToQueue() {
    if (!canSubmit || sending) return;
    setSending(true);
    try {
      await api.enqueueMessage(taskId, text.trim(), images);
      setText("");
      setImages([]);
      onMessageSent?.();
    } catch (err) {
      void errorDialog(err);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="chat-tab-shell">
      <div className="chat-list" ref={listRef}>
        {messages.length === 0 && <div className="empty-state">暂无对话</div>}
        {messages.map((m) => {
          const renderedImages = Array.from(new Set([...m.images, ...extractReturnedImagePaths(m.content)]));
          const snapshot = snapshotByMessage.get(m.id);
          return (
            <div key={m.id} className={`chat-bubble ${m.role}`}>
              <div className="role-label">
                <span>{m.role === "user" ? "你" : m.role === "agent" ? (role?.name ?? "Agent") : "系统"}</span>
                {role && m.role !== "system" && m.content && (
                  <button className="chat-undo-button" type="button" title={`存为「${role.name}」的长期记忆`} onClick={() => void rememberMessage(m.content)}>
                    记住这条
                  </button>
                )}
                {snapshot && (
                  <button
                    className="chat-undo-button"
                    type="button"
                    disabled={busy || restoringId !== null}
                    title={busy ? "等这一轮结束再撤回" : snapshot.kind === "before_restore" ? "把文件恢复到这次撤回之前" : "把工作区文件回退到这条消息发出之前"}
                    onClick={() => void restoreFrom(snapshot)}
                  >
                    {restoringId === snapshot.id ? "处理中..." : snapshot.kind === "before_restore" ? "恢复撤回前的文件" : "撤回这一轮"}
                  </button>
                )}
              </div>
              {m.content && (m.role === "agent" ? <AgentText text={m.content} /> : <div>{m.content}</div>)}
              {renderedImages.length > 0 && (
                <div className="chat-attachments">
                  {renderedImages.map((img, index) => (
                    <a key={`${img}-${index}`} href={attachmentUrl(img)} target="_blank" rel="noreferrer" title={img}>
                      <img src={attachmentUrl(img)} alt={basename(img)} />
                    </a>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {status === "running" && (
          <div className="chat-bubble agent typing-indicator">
            <div className="role-label">Agent</div>
            <span className="typing-dots">
              <span />
              <span />
              <span />
            </span>
            正在处理…
          </div>
        )}
      </div>

      <QueuePanel taskId={taskId} items={queue} />

      {role && <RoleMemoryProposals roleId={role.roleId} roleName={role.name} refreshKey={messages.length} />}

      {planMode && (
        <div className="plan-mode-bar">
          <div className="plan-mode-copy">
            <strong>计划模式已开启</strong>
            <span>
              Agent 只调研、出方案，不改文件。看完方案满意就点"批准并执行"；想调整就直接回复修改意见。
              {!planEnforced && " 当前 Agent 没有原生只读机制，只能靠指令约束，不能完全保证不改文件。"}
            </span>
          </div>
          <button
            className="btn btn-primary btn-sm"
            type="button"
            disabled={busy || planBusy || !hasAgentReply}
            title={!hasAgentReply ? "Agent 还没给出方案" : busy ? "等这一轮结束再批准" : "退出计划模式，并让 Agent 按方案开始执行"}
            onClick={() => void runPlanAction(onApprovePlan)}
          >
            批准并执行
          </button>
        </div>
      )}
      {planError && <div className="form-error">{planError}</div>}

      <AttachmentChips images={images} onChange={setImages} />
      {speechError && <div className="speech-status speech-error">{speechError}</div>}
      <div className="chat-input-row chat-composer-frame">
        <textarea
          className="field chat-composer-textarea"
          placeholder={busy ? "任务正在运行，输入的内容会加入队列，等这一轮做完自动继续" : "输入消息，继续与 agent 对话...（可直接粘贴截图）"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (busy) addToQueue();
              else send();
            }
          }}
        />
        <div className="chat-composer-toolbar">
          <div className="chat-composer-tools">
            <AttachmentButton
              ref={attachRef}
              className="composer-tool-button"
              title="添加附件（也可以直接把截图粘贴进输入框）"
              onChange={(uploaded) => setImages((prev) => [...prev, ...uploaded])}
            >
              <Paperclip size={15} strokeWidth={2} />
              <span>添加附件</span>
            </AttachmentButton>
            <button className="btn btn-sm composer-tool-button" type="button" onClick={() => attachRef.current?.openPicker()} title="选择截图图片，或直接粘贴截图">
              <Image size={15} strokeWidth={2} />
              <span>截图</span>
            </button>
            <button
              className={`btn btn-sm composer-tool-button plan-mode-toggle ${planMode ? "active" : ""}`}
              type="button"
              disabled={planBusy}
              aria-pressed={planMode}
              title={planMode ? "关闭计划模式（之后的消息 Agent 会直接动手）" : "开启计划模式：Agent 先出方案、不改文件，批准后再执行"}
              onClick={() => void runPlanAction(() => onSetPlanMode(!planMode))}
            >
              <ListChecks size={15} strokeWidth={2} />
              <span>计划模式</span>
            </button>
          </div>
          <div className="chat-composer-actions">
            <button
              className={`btn btn-sm speech-button composer-icon-button ${listening ? "listening" : ""}`}
              onClick={toggleSpeechInput}
              type="button"
              title={listening ? `停止语音输入，已听写 ${speechSeconds}s` : "语音输入，识别结果会填入输入框"}
            >
              <Mic size={16} strokeWidth={2.1} />
            </button>
            <button
              className="btn btn-primary composer-send-button"
              onClick={busy ? addToQueue : send}
              disabled={sending || !canSubmit}
              title={busy ? "任务运行中，这条消息会加入队列" : undefined}
            >
              <SendHorizontal size={15} strokeWidth={2.1} />
              <span>发送</span>
            </button>
            <button className="btn btn-primary composer-send-menu" onClick={addToQueue} disabled={sending || !canSubmit} title="加入队列">
              <ChevronDown size={14} strokeWidth={2.4} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
