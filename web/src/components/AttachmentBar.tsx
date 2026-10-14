import { forwardRef, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { uploadImageFiles } from "../utils/attachments";

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function attachmentUrl(path: string): string {
  return `/api/attachments/file?path=${encodeURIComponent(path)}`;
}

export interface AttachmentButtonHandle {
  /** 供外部（比如输入框的粘贴事件）直接塞文件进来上传，不用先点按钮弹文件选择框。 */
  handleFiles: (files: File[] | FileList) => void;
  openPicker: () => void;
}

interface ButtonProps {
  onChange: (append: string[]) => void;
  children?: ReactNode;
  className?: string;
  title?: string;
}

/** 消息输入框旁边的"添加图片"按钮：点开文件选择框，或由外部（粘贴事件）直接喂文件进来。 */
export const AttachmentButton = forwardRef<AttachmentButtonHandle, ButtonProps>(function AttachmentButton(
  { onChange, children, className, title },
  ref
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function handleFiles(files: File[] | FileList) {
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(true);
    try {
      const uploaded = await uploadImageFiles(list);
      onChange(uploaded);
    } catch (err) {
      alert(`上传图片失败：${(err as Error).message}`);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  useImperativeHandle(ref, () => ({ handleFiles, openPicker: () => inputRef.current?.click() }));

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: "none" }}
        onChange={(e) => e.target.files && handleFiles(e.target.files)}
      />
      <button
        type="button"
        className={`btn btn-sm attachment-button ${className ?? ""}`.trim()}
        title={title ?? "添加图片（也可以直接把截图粘贴进输入框）"}
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
      >
        {uploading ? "上传中…" : children ?? "📎"}
      </button>
    </>
  );
});

/** 已选图片的缩略图列表，放在输入框上方，为空时不渲染。 */
export function AttachmentChips({ images, onChange }: { images: string[]; onChange: (images: string[]) => void }) {
  if (images.length === 0) return null;
  return (
    <div className="attachment-bar">
      {images.map((img, i) => (
        <span key={img + i} className="attachment-preview" title={img}>
          <img src={attachmentUrl(img)} alt={basename(img)} />
          <span>{basename(img)}</span>
          <button type="button" onClick={() => onChange(images.filter((_, idx) => idx !== i))}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
