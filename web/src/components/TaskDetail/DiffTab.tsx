import type { FileChange } from "../../api/types";

const ACTION_LABEL: Record<FileChange["action"], string> = {
  created: "新建",
  modified: "修改",
  deleted: "删除",
};

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "diff-ctx";
  if (line.startsWith("@@")) return "diff-hunk";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-del";
  return "diff-ctx";
}

function DiffBlock({ file }: { file: FileChange }) {
  if (!file.diff) return null;
  const lines = file.diff.split("\n");
  return (
    <div className="diff-block">
      <div className="diff-file-header">
        {file.path} <span className={`action-tag action-${file.action}`} style={{ marginLeft: 8 }}>{ACTION_LABEL[file.action]}</span>
      </div>
      <div>
        {lines.map((line, i) => (
          <div key={i} className={`diff-line ${lineClass(line)}`}>
            {line || " "}
          </div>
        ))}
      </div>
    </div>
  );
}

export function DiffTab({ files }: { files: FileChange[] }) {
  const withDiff = files.filter((f) => f.diff);
  return (
    <div style={{ paddingBottom: 16 }}>
      {withDiff.length === 0 && <div className="empty-state">暂无 diff</div>}
      {withDiff.map((f) => (
        <DiffBlock key={f.id} file={f} />
      ))}
    </div>
  );
}
