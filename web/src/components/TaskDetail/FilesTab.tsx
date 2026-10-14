import type { FileChange } from "../../api/types";

const ACTION_LABEL: Record<FileChange["action"], string> = {
  created: "新建",
  modified: "修改",
  deleted: "删除",
};

export function FilesTab({ files, onOpenDiff }: { files: FileChange[]; onOpenDiff: () => void }) {
  return (
    <div>
      {files.length === 0 && <div className="empty-state">agent 尚未修改任何文件</div>}
      {files.map((f) => (
        <div key={f.id} className="file-row" onClick={f.diff ? onOpenDiff : undefined} style={{ cursor: f.diff ? "pointer" : "default" }}>
          <span className={`action-tag action-${f.action}`}>{ACTION_LABEL[f.action]}</span>
          <span className="path">{f.path}</span>
        </div>
      ))}
    </div>
  );
}
