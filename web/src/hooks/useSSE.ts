import { useEffect, useRef } from "react";

/** 订阅一个 SSE 端点，收到 `eventName` 事件时调用 onEvent(data)。 */
export function useSSE<T = any>(url: string | null, eventName: string, onEvent: (data: T) => void) {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!url) return;
    const es = new EventSource(url, { withCredentials: true });
    const listener = (ev: MessageEvent) => {
      try {
        handlerRef.current(JSON.parse(ev.data));
      } catch {
        // 忽略无法解析的消息
      }
    };
    es.addEventListener(eventName, listener as EventListener);
    es.onerror = () => {
      // EventSource 会自动重连，这里不需要手动处理
    };
    return () => {
      es.removeEventListener(eventName, listener as EventListener);
      es.close();
    };
  }, [url, eventName]);
}
