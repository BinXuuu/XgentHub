// 桌面壳的预加载脚本：只做一件事——把对话里的图片拖出窗口时，拖的是本机的图片文件
// （能直接放到桌面、文件夹、聊天软件里），而不是一串网址。
//
// 网页里显示的图片地址是 /api/tasks/<任务>/image?path=<本机路径>；拖动开始时把地址交给主进程，
// 主进程核对确实是本机存在的图片后用 webContents.startDrag 发起系统的文件拖动。
"use strict";
const { ipcRenderer } = require("electron");

const IMAGE_API = /\/api\/(?:tasks|chats)\/[^/]+\/image\?/;

document.addEventListener(
  "dragstart",
  (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== "function") return;
    // 图片外面常包着链接，拖的时候 target 可能是 <a>
    const img = target.tagName === "IMG" ? target : target.querySelector && target.querySelector("img");
    const src = img && (img.currentSrc || img.src);
    if (!src || !IMAGE_API.test(src)) return;
    event.preventDefault();
    ipcRenderer.send("xgent:drag-image", src);
  },
  true
);
