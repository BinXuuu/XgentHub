import { useEffect, useRef } from "react";

export function TerminalTab({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);

  return (
    <div className="terminal-pane" ref={ref}>
      {text || "(暂无终端输出)"}
    </div>
  );
}
