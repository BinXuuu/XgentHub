// 应用内的确认 / 提示 / 输入弹窗，替代浏览器自带的 confirm / alert / prompt：
// 系统弹窗样式改不了，在桌面版里标题还固定显示 "Electron"。
// 用法和原来一样，只是要 await：if (!(await confirmDialog("删除？", { danger: true }))) return;
// 真正的界面在 components/DialogHost.tsx，挂在 main.tsx 的最外层。

export type DialogTone = "info" | "danger" | "error" | "success";

interface DialogBase {
  id: number;
  title: string;
  message: string;
  tone: DialogTone;
  confirmText: string;
}

export type DialogRequest =
  | (DialogBase & { kind: "confirm"; cancelText: string; resolve: (value: boolean) => void })
  | (DialogBase & { kind: "alert"; resolve: (value: void) => void })
  | (DialogBase & { kind: "prompt"; cancelText: string; defaultValue: string; resolve: (value: string | null) => void });

let nextId = 1;
let queue: DialogRequest[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function push(request: DialogRequest) {
  queue = [...queue, request];
  emit();
}

export function subscribeDialogs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDialogQueue(): DialogRequest[] {
  return queue;
}

/** DialogHost 调用：关掉最前面的弹窗并把结果交回给 await 它的地方。 */
export function settleDialog(id: number, value: boolean | string | null): void {
  const request = queue.find((item) => item.id === id);
  if (!request) return;
  queue = queue.filter((item) => item.id !== id);
  emit();
  if (request.kind === "confirm") request.resolve(Boolean(value));
  else if (request.kind === "prompt") request.resolve(typeof value === "string" ? value : null);
  else request.resolve();
}

export function confirmDialog(
  message: string,
  options: { title?: string; confirmText?: string; cancelText?: string; danger?: boolean } = {}
): Promise<boolean> {
  return new Promise((resolve) =>
    push({
      kind: "confirm",
      id: nextId++,
      title: options.title ?? (options.danger ? "确认删除" : "请确认"),
      message,
      tone: options.danger ? "danger" : "info",
      confirmText: options.confirmText ?? (options.danger ? "删除" : "确定"),
      cancelText: options.cancelText ?? "取消",
      resolve,
    })
  );
}

export function alertDialog(message: string, options: { title?: string; tone?: Exclude<DialogTone, "danger"> } = {}): Promise<void> {
  const tone = options.tone ?? "info";
  return new Promise((resolve) =>
    push({
      kind: "alert",
      id: nextId++,
      title: options.title ?? (tone === "error" ? "操作没有成功" : tone === "success" ? "完成" : "提示"),
      message,
      tone,
      confirmText: "知道了",
      resolve,
    })
  );
}

/** 接口报错之类的失败提示：直接把 Error 传进来。 */
export function errorDialog(err: unknown, title = "操作没有成功"): Promise<void> {
  const message = err instanceof Error ? err.message : String(err ?? "未知错误");
  return alertDialog(message || "未知错误", { title, tone: "error" });
}

export function promptDialog(
  message: string,
  options: { title?: string; defaultValue?: string; confirmText?: string; cancelText?: string } = {}
): Promise<string | null> {
  return new Promise((resolve) =>
    push({
      kind: "prompt",
      id: nextId++,
      title: options.title ?? "请输入",
      message,
      tone: "info",
      confirmText: options.confirmText ?? "确定",
      cancelText: options.cancelText ?? "取消",
      defaultValue: options.defaultValue ?? "",
      resolve,
    })
  );
}
