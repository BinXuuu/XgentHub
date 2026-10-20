import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

// Agent 的回复大多是 Markdown（加粗、列表、代码块、表格）。
// remark-breaks：保留单个换行——Agent 经常一行一条地写，按标准 Markdown 会被挤成一段。
// react-markdown 默认不渲染原始 HTML，回复里的 <script> 之类只会当文字显示。
const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
  table: ({ node: _node, ...props }) => (
    <div className="md-table-wrap">
      <table {...props} />
    </div>
  ),
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
