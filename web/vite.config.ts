import path from "node:path";
import fs from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import dotenv from "dotenv";

// 复用仓库根目录的 .env（和后端 server/src/config.ts 一样的开关），
// 这样 HOST/ALLOW_LAN_BIND 只需要配一处，局域网访问时前后端一起生效。
const rootEnvPath = path.resolve(__dirname, "../.env");
if (fs.existsSync(rootEnvPath)) dotenv.config({ path: rootEnvPath });

const allowLan = process.env.ALLOW_LAN_BIND === "true" || process.env.ALLOW_LAN_BIND === "1";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // 第三方库单独成文件：AgentHub 自己的代码改了以后，浏览器缓存里的这几块不用重新下载。
        manualChunks: {
          react: ["react", "react-dom"],
          icons: ["lucide-react"],
        },
      },
    },
  },
  server: {
    host: allowLan ? "0.0.0.0" : "127.0.0.1",
    port: 5180,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4180",
        changeOrigin: true,
      },
    },
  },
});
