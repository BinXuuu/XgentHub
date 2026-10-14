import { nanoid } from "nanoid";
import { db } from "../db/index.ts";
import { bus } from "../eventBus.ts";
import type { NotificationItem, NotificationLevel } from "../types.ts";

function now(): string {
  return new Date().toISOString();
}

function rowToNotification(row: any): NotificationItem {
  return {
    id: row.id,
    level: row.level,
    title: row.title,
    detail: row.detail,
    taskId: row.task_id,
    source: row.source,
    sourceKey: row.source_key,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export function listNotifications(input: { unreadOnly?: boolean; limit?: number } = {}): NotificationItem[] {
  const limit = Math.max(1, Math.min(input.limit ?? 80, 200));
  const rows = input.unreadOnly
    ? (db.prepare("SELECT * FROM notifications WHERE read_at IS NULL ORDER BY created_at DESC LIMIT ?").all(limit) as any[])
    : (db.prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?").all(limit) as any[]);
  return rows.map(rowToNotification);
}

export function createNotification(input: {
  level: NotificationLevel;
  title: string;
  detail?: string;
  taskId?: string | null;
  source: string;
  sourceKey: string;
}): NotificationItem {
  const existing = db.prepare("SELECT * FROM notifications WHERE source_key = ?").get(input.sourceKey) as any;
  if (existing) return rowToNotification(existing);

  const id = nanoid();
  const createdAt = now();
  db.prepare(
    "INSERT INTO notifications (id, level, title, detail, task_id, source, source_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, input.level, input.title, input.detail ?? "", input.taskId ?? null, input.source, input.sourceKey, createdAt);
  const notification = rowToNotification(db.prepare("SELECT * FROM notifications WHERE id = ?").get(id));
  bus.publishNotification(notification);
  return notification;
}

export function markNotificationRead(id: string): NotificationItem | undefined {
  const row = db.prepare("SELECT * FROM notifications WHERE id = ?").get(id) as any;
  if (!row) return undefined;
  const readAt = row.read_at ?? now();
  db.prepare("UPDATE notifications SET read_at = ? WHERE id = ?").run(readAt, id);
  return rowToNotification({ ...row, read_at: readAt });
}

export function markNotificationReadBySourceKey(sourceKey: string): NotificationItem | undefined {
  const row = db.prepare("SELECT * FROM notifications WHERE source_key = ?").get(sourceKey) as any;
  if (!row) return undefined;
  return markNotificationRead(row.id);
}

export function markAllNotificationsRead(): number {
  const readAt = now();
  const result = db.prepare("UPDATE notifications SET read_at = ? WHERE read_at IS NULL").run(readAt);
  return Number(result.changes ?? 0);
}
