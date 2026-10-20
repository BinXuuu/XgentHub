import { lazy, Suspense } from "react";

// Markdown 渲染库比较大（react-markdown + micromark），按需加载：打开对话时才下载，
// 加载完之前先按纯文字显示，不拖慢首页。
const Markdown = lazy(() => import("./Markdown").then((module) => ({ default: module.Markdown })));

export function AgentText({ text }: { text: string }) {
  return (
    <Suspense fallback={<div className="md-fallback">{text}</div>}>
      <Markdown text={text} />
    </Suspense>
  );
}
