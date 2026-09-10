import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { attachDevTokenForSameOrigin, ensureBridgeTokenInitialized } from "./server/bridge/bridgeAuth";
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
          if (id.includes("node_modules/exceljs/")) return "exceljs";
          if (id.includes("node_modules/pptxgenjs/")) return "pptxgenjs";
          if (id.includes("node_modules/@huggingface/")) return "transformers";
          if (id.includes("node_modules/mammoth/")) return "mammoth";
          // three 生态单独成 chunk：首屏 BlobScene 懒加载后，首包不再常驻 three；
          // Luminous/Echo 仍在首包依赖该 chunk，但代码已外移，首包解析体积下降。
          if (
            id.includes("node_modules/three")
            || id.includes("node_modules/@react-three/fiber")
            || id.includes("node_modules/@react-three/postprocessing")
            || id.includes("node_modules/postprocessing")
          ) {
            return "three";
          }
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
        // P0-1：vite dev 的 /void-model-proxy 不再是无鉴权开放代理。
        // dev token 单一真源为运行时共享文件（bridgeAuth resolveDevBridgeTokenFilePath）：
        // 此处 ensure 只做文件收敛（bridge 先起则复用，无文件才原子生成），不再有
        // per-process 分叉；无文件才原子生成并落盘（双进程竞写后来者复用赢家）。
        // 恶意 Origin 直接 403；同源 dev 缺 token 时内部补齐，再进 handleModelProxy
        // 第二道统一校验 + 严格目标 allowlist。取舍：同源 dev 免手填 token 保可用，
        // 跨站一律凭 token，空 token 裸奔关闭。
        ensureBridgeTokenInitialized();
        server.middlewares.use("/void-model-proxy", (request, response) => {
          if (!attachDevTokenForSameOrigin(request)) {
            response.statusCode = 403;
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.end(JSON.stringify({
              ok: false,
              error: { code: "ORIGIN_FORBIDDEN", message: "请求 Origin 不在允许列表内" }
            }));
            return;
          }
          void handleModelProxy(request, response);
        });
      }
    }
  ]
});
