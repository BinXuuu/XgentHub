import { useState } from "react";
import type { QueuedMessage } from "../../api/types";
import { api } from "../../api/client";
import { errorDialog } from "../../utils/dialog";

interface Props {
  taskId: string;
  items: QueuedMessage[];
}

/** 排队中的后续指令：可拖拽调整顺序、可删除。当前任务做完一条，会自动从这里取下一条继续。 */
export function QueuePanel({ taskId, items }: Props) {
  const [dragId, setDragId] = useState<string | null>(null);

  if (items.length === 0) return null;

  async function remove(id: string) {
    try {
      await api.removeQueueItem(taskId, id);
    } catch (err) {
      void errorDialog(err);
    }
  }

  async function onDrop(targetId: string) {
    if (!dragId || dragId === targetId) return;
    const ids = items.map((i) => i.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    setDragId(null);
    try {
      await api.reorderQueue(taskId, ids);
    } catch (err) {
      void errorDialog(err);
    }
  }

  return (
    <div className="queue-panel">
      <h4>排队中（{items.length}）· 拖拽调整顺序</h4>
      {items.map((item, i) => (
        <div
          key={item.id}
          className={`queue-item ${dragId === item.id ? "dragging" : ""}`}
          draggable
          onDragStart={() => setDragId(item.id)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => onDrop(item.id)}
          onDragEnd={() => setDragId(null)}
        >
          <span className="drag-handle">⠿</span>
          <span className="queue-index">{i + 1}</span>
          <span className="content">
            {item.content}
            {item.images.length > 0 ? ` (📎${item.images.length})` : ""}
          </span>
          <button className="remove" onClick={() => remove(item.id)} title="删除">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
