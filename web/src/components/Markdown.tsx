import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { ChatImage } from "./ChatImage";

// Agent 的回复大多是 Markdown（加粗、列表、代码块、表格）。
// remark-breaks：保留单个换行——Agent 经常一行一条地写，按标准 Markdown 会被挤成一段。
// react-markdown 默认不渲染原始 HTML，回复里的 <script> 之类只会当文字显示。
const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
  img: ({ node: _node, src, alt, title }) => (typeof src === "string" && src ? <ChatImage src={src} alt={alt || undefined} title={title} /> : null),
  table: ({ node: _node, ...props }) => (
    <div className="md-table-wrap">
      <table {...props} />
    </div>
  ),
};

/**
 * resolveLocal：把回复里的本机文件路径（file:///C:/…、/C:/…、C:\…）换成页面能打开的地址，换不了返回 null。
 * 不传的话按默认规则处理（file: 链接会被去掉）。
 */
export function Markdown({ text, resolveLocal }: { text: string; resolveLocal?: (url: string) => string | null }) {
  const urlTransform: UrlTransform = (url) => resolveLocal?.(url) ?? defaultUrlTransform(url);
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components} urlTransform={urlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
