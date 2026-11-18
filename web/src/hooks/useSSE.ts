import { useEffect, useRef, useState } from "react";

/**
 * 订阅一个 SSE 端点，收到 `eventName` 事件时调用 onEvent(data)。
 *
 * 断线期间推送的事件不会补发，所以重新连上时调用 onReconnect，让页面把数据整体重新拉一遍（数据库里的状态才是准的）。
 * EventSource 网络断开时会自己重连；但服务重启期间收到错误响应它会直接放弃（readyState 变成 CLOSED），
 * 这种情况由这里隔几秒重建连接，间隔逐步拉长到 30 秒。
 */
export function useSSE<T = any>(url: string | null, eventName: string, onEvent: (data: T) => void, onReconnect?: () => void) {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;
  const reconnectRef = useRef(onReconnect);
  reconnectRef.current = onReconnect;
  const [generation, setGeneration] = useState(0);
  const openedOnceRef = useRef(false);
  const retryDelayRef = useRef(3000);

  useEffect(() => {
    openedOnceRef.current = false;
    retryDelayRef.current = 3000;
  }, [url, eventName]);

  useEffect(() => {
    if (!url) return;
    const es = new EventSource(url, { withCredentials: true });
    let retryTimer: number | null = null;
    const listener = (ev: MessageEvent) => {
      try {
        handlerRef.current(JSON.parse(ev.data));
      } catch {
        // 忽略无法解析的消息
      }
    };
    es.addEventListener(eventName, listener as EventListener);
    es.onopen = () => {
      retryDelayRef.current = 3000;
      if (openedOnceRef.current) reconnectRef.current?.();
      openedOnceRef.current = true;
    };
    es.onerror = () => {
      if (es.readyState !== EventSource.CLOSED || retryTimer !== null) return;
      const delay = retryDelayRef.current;
      retryDelayRef.current = Math.min(delay * 2, 30000);
      retryTimer = window.setTimeout(() => setGeneration((n) => n + 1), delay);
    };
    return () => {
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      es.removeEventListener(eventName, listener as EventListener);
      es.close();
    };
  }, [url, eventName, generation]);
}
