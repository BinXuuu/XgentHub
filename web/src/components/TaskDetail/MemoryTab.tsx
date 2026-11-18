import type { MemoryEntry } from "../../api/types";

const MEMORY_KIND_LABEL: Record<string, string> = {
  task_summary: "任务总结",
};

export function MemoryTab({ memories }: { memories: MemoryEntry[] }) {
  if (memories.length === 0) return <div className="empty-state">暂无记忆</div>;
  return (
    <div className="memory-list">
      {memories.map((memory) => (
        <article className="memory-card" key={memory.id}>
          <div className="memory-card-head">
            <span>{MEMORY_KIND_LABEL[memory.kind] ?? memory.kind}</span>
            <time>{new Date(memory.createdAt).toLocaleString("zh-CN", { hour12: false })}</time>
          </div>
          <strong title={memory.title}>{memory.title}</strong>
          <pre>{memory.content}</pre>
        </article>
      ))}
    </div>
  );
}
