import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { getDialogQueue, settleDialog, subscribeDialogs, type DialogRequest } from "../utils/dialog";

const TONE_ICON = {
  info: Info,
  danger: AlertTriangle,
  error: XCircle,
  success: CheckCircle2,
} as const;

/** 一次只显示最前面的一个弹窗，后面的排队。回车确认、Esc 取消，点遮罩等于取消。 */
export function DialogHost() {
  const queue = useSyncExternalStore(subscribeDialogs, getDialogQueue);
  const current = queue[0];
  if (!current) return null;
  return <DialogCard key={current.id} request={current} />;
}

function DialogCard({ request }: { request: DialogRequest }) {
  const [value, setValue] = useState(request.kind === "prompt" ? request.defaultValue : "");
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const Icon = TONE_ICON[request.tone];

  const cancel = () => settleDialog(request.id, request.kind === "prompt" ? null : false);
  const confirm = () => settleDialog(request.id, request.kind === "prompt" ? value : true);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    if (request.kind === "prompt") {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (request.tone === "danger") {
      // 删除这类操作焦点先放在"取消"上：顺手按回车不会误删，要删得点红色按钮。
      cancelRef.current?.focus();
    } else {
      confirmRef.current?.focus();
    }
    return () => previous?.focus?.();
  }, [request.kind, request.tone]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      } else if (event.key === "Enter" && event.target instanceof HTMLButtonElement) {
        // 焦点在某个按钮上（比如用 Tab 移到了"取消"）：让回车按那个按钮自己的行为走。
        return;
      } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        // 输入框里 Shift+Enter 换行，Enter 确认；输入法选词时的回车不算。
        event.preventDefault();
        confirm();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    <div className="app-dialog-overlay" onMouseDown={(event) => event.target === event.currentTarget && cancel()}>
      <div
        className={`app-dialog tone-${request.tone}`}
        role={request.kind === "alert" ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={`app-dialog-title-${request.id}`}
      >
        <div className="app-dialog-head">
          <span className="app-dialog-icon">
            <Icon size={18} strokeWidth={2.2} />
          </span>
          <h3 id={`app-dialog-title-${request.id}`}>{request.title}</h3>
        </div>
        <div className="app-dialog-message">{request.message}</div>
        {request.kind === "prompt" &&
          (request.secret || request.singleLine ? (
            <input
              ref={inputRef}
              className="field app-dialog-input"
              type={request.secret ? "password" : "text"}
              autoComplete="off"
              placeholder={request.placeholder}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          ) : (
            <textarea ref={inputRef} className="field app-dialog-input" rows={4} placeholder={request.placeholder} value={value} onChange={(event) => setValue(event.target.value)} />
          ))}
        <div className="app-dialog-actions">
          {request.kind !== "alert" && (
            <button ref={cancelRef} type="button" className="btn" onClick={cancel}>
              {request.cancelText}
            </button>
          )}
          <button
            ref={confirmRef}
            type="button"
            className={`btn ${request.tone === "danger" ? "app-dialog-danger" : "btn-primary"}`}
            onClick={confirm}
          >
            {request.confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
