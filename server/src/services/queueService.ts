import { nanoid } from "nanoid";
import { db } from "../db/index.ts";
import type { QueuedMessage } from "../types.ts";

function rowToItem(row: any): QueuedMessage {
  return {
    id: row.id,
    taskId: row.task_id,
    content: row.content,
    images: JSON.parse(row.images),
    position: row.position,
    createdAt: row.created_at,
  };
}

export function listQueue(taskId: string): QueuedMessage[] {
  const rows = db.prepare("SELECT * FROM message_queue WHERE task_id = ? ORDER BY position ASC").all(taskId) as any[];
  return rows.map(rowToItem);
}

export function enqueue(taskId: string, content: string, images: string[]): QueuedMessage {
  const maxRow = db.prepare("SELECT MAX(position) as m FROM message_queue WHERE task_id = ?").get(taskId) as { m: number | null };
  const position = (maxRow.m ?? -1) + 1;
  const id = nanoid();
  const createdAt = new Date().toISOString();
  db.prepare(
    "INSERT INTO message_queue (id, task_id, content, images, position, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, taskId, content, JSON.stringify(images), position, createdAt);
  return rowToItem({ id, task_id: taskId, content, images: JSON.stringify(images), position, created_at: createdAt });
}

export function removeItem(taskId: string, itemId: string): void {
  db.prepare("DELETE FROM message_queue WHERE id = ? AND task_id = ?").run(itemId, taskId);
}

/** 用一份完整的有序 id 列表重排队列。 */
export function reorder(taskId: string, orderedIds: string[]): QueuedMessage[] {
  const update = db.prepare("UPDATE message_queue SET position = ? WHERE id = ? AND task_id = ?");
  orderedIds.forEach((id, index) => update.run(index, id, taskId));
  return listQueue(taskId);
}

/** 取出并删除队列中最靠前的一条；没有则返回 null。 */
export function dequeueNext(taskId: string): QueuedMessage | null {
  const row = db.prepare("SELECT * FROM message_queue WHERE task_id = ? ORDER BY position ASC LIMIT 1").get(taskId) as any;
  if (!row) return null;
  db.prepare("DELETE FROM message_queue WHERE id = ?").run(row.id);
  return rowToItem(row);
}
