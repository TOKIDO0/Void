import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { handleModelProxy } from "./server/voidProxyMiddleware";

export default defineConfig({
  // Tauri 集成必需配置：
  // 1) clearScreen:false —— 保留 cargo/桥接编译日志，报错不被清屏冲掉，便于排查。
  // 2) strictPort —— 固定 5173，端口被占直接报错而非漂移，避免 Tauri devUrl 连到空窗口。
  // 3) watch.ignored src-tauri/ —— cargo 编译会在 target/ 高频生成并独占锁定大量 .dll，
  //    若 vite 文件监听器去 watch 这些文件会触发 EBUSY 崩溃、连带拖垮整个 tauri dev.
  clearScreen: false,
  server: {
    strictPort: true,
    // 开发期禁止浏览器强缓存依赖与源码模块，避免 Chrome 出现
    // net::ERR_CACHE_READ_FAILURE（磁盘缓存索引损坏/被清理后读失败）。
    // 仅影响 dev server，不影响生产 build。
    headers: {
      "Cache-Control": "no-store"
    },
    watch: {
      ignored: ["**/src-tauri/**"]
    }
  },
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          // 重型按需库：仅部分工具/文档链路触达，拆出避免常驻首包
          if (id.includes("node_modules/pdfjs-dist/")) return "pdfjs";
          if (id.includes("node_modules/xlsx/")) return "xlsx";
          if (id.includes("node_modules/@huggingface/")) return "transformers";
          if (id.includes("node_modules/mammoth/")) return "mammoth";
          // 其余第三方（含框架）归一，避免框架/vendor 循环依赖
          return "vendor";
        }
      }
    }
  },
  plugins: [
    react(),
    {
      name: "void-model-proxy",
      configureServer(server) {
        // 文本模型 HTTP 转发逻辑与 sidecar 共享（server/voidProxyMiddleware.ts）。
        // 豆包语音已由客户端直连托管 Worker，不再挂载本地语音桥接。
        server.middlewares.use("/void-model-proxy", (request, response) => {
          void handleModelProxy(request, response);
        });
      }
    }
  ]
});
