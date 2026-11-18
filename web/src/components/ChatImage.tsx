import { useState, type DragEvent } from "react";

function nameOf(src: string, alt?: string): string {
  if (alt) return alt;
  try {
    const url = new URL(src, window.location.href);
    return (url.searchParams.get("path") ?? url.pathname).split(/[\\/]/).pop() || "图片";
  } catch {
    return "图片";
  }
}

/**
 * 对话里的图片。打不开时（多半是 Agent 后来把文件移走、改名或删掉了）不显示浏览器的破图标，
 * 而是写明「图片不在原来的位置了」和文件名，免得以为是 Xgent 把图弄丢了。
 */
export function ChatImage({ src, alt, title, link = false }: { src: string; alt?: string; title?: string; link?: boolean }) {
  const [missing, setMissing] = useState(false);
  const name = nameOf(src, alt);
  if (missing) {
    return (
      <span className="chat-image-missing" title={title ?? name}>
        <strong>图片不在原来的位置了</strong>
        <span>{name}</span>
        <small>可能被移走、改名或删除</small>
      </span>
    );
  }
  // 拖到窗口外（桌面、文件夹）时给的是图片文件而不是网址：Chrome 认 DownloadURL（「类型:文件名:地址」）。
  // Xgent 桌面版在预加载脚本里另外接管，直接拖本机的原文件。
  const onDragStart = (event: DragEvent<HTMLElement>) => {
    const absolute = new URL(src, window.location.href).href;
    const ext = name.split(".").pop()?.toLowerCase() ?? "png";
    const type = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
    event.dataTransfer.setData("DownloadURL", `${type}:${name.replace(/:/g, "_")}:${absolute}`);
  };
  const img = <img src={src} alt={name} title={title} onError={() => setMissing(true)} onDragStart={link ? undefined : onDragStart} />;
  return link ? (
    <a href={src} target="_blank" rel="noreferrer" title={title} onDragStart={onDragStart}>
      {img}
    </a>
  ) : (
    img
  );
}
