import { useEffect, useState } from "react";

/**
 * 「消息通知」：任务完成、出错、等你审批时，在屏幕右下角弹系统通知（页面不在前台时才弹）。
 * - 开关存在这个浏览器里，默认打开；
 * - 浏览器第一次要用户点「允许」，http + 局域网 IP 打开时浏览器不给通知（只能 https / localhost）；
 * - 在 Xgent Hub 应用版（xgent://）里由应用自己弹，开关在托盘菜单「设置」里，网页这边不再弹，免得一条通知弹两次。
 */
const KEY = "xgent-hub:system-notifications:v1";
const CHANGED = "xgent-hub:system-notifications-changed";

export const isDesktopApp = () => typeof window !== "undefined" && window.location.protocol === "xgent:";

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window && window.isSecureContext && !isDesktopApp();
}

export function notificationsEnabled(): boolean {
  try {
    return window.localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function setNotificationsEnabled(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // 存不了就只在这次打开期间生效
  }
  window.dispatchEvent(new Event(CHANGED));
}

/** 开关、浏览器权限，任何一个变了都会刷新 */
export function useNotificationSetting(): {
  enabled: boolean;
  permission: NotificationPermission | "unsupported";
  setEnabled: (on: boolean) => Promise<void>;
} {
  const read = () => (notificationsSupported() ? Notification.permission : "unsupported");
  const [enabled, setEnabledState] = useState(notificationsEnabled);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(read);

  useEffect(() => {
    const sync = () => {
      setEnabledState(notificationsEnabled());
      setPermission(read());
    };
    window.addEventListener(CHANGED, sync);
    window.addEventListener("focus", sync);
    return () => {
      window.removeEventListener(CHANGED, sync);
      window.removeEventListener("focus", sync);
    };
  }, []);

  async function setEnabled(on: boolean) {
    // 打开时顺便向浏览器要权限（必须在点击里调用，浏览器才会弹「允许通知」）
    if (on && notificationsSupported() && Notification.permission === "default") await Notification.requestPermission();
    setNotificationsEnabled(on);
  }

  return { enabled, permission, setEnabled };
}

/** 页面在前台（看得见且有焦点）时不弹系统通知，页面里自己会提示 */
export const pageInForeground = () => document.visibilityState === "visible" && document.hasFocus();

/** 能弹就弹一条系统通知；点通知回到页面并执行 onClick。弹不了（关了、没权限、应用版）返回 false */
export function showSystemNotification(title: string, options: { body?: string; tag?: string; onClick?: () => void }): boolean {
  if (!notificationsSupported() || !notificationsEnabled() || Notification.permission !== "granted") return false;
  try {
    const notice = new Notification(title, { body: options.body, tag: options.tag });
    notice.onclick = () => {
      window.focus();
      options.onClick?.();
      notice.close();
    };
    return true;
  } catch {
    return false;
  }
}
