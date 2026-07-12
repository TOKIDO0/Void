// 注册内置工具。真实工具与假工具都从这里挂载，不散落在 UI。

import { browserClickTool } from "./builtin/browserClickTool";
import { browserExtractTool } from "./builtin/browserExtractTool";
import { browserOpenTool } from "./builtin/browserOpenTool";
import { browserReadResultTool } from "./builtin/browserReadResultTool";
import { browserRevealInSystemBrowserTool } from "./builtin/browserRevealInSystemBrowserTool";
import { browserScreenshotTool } from "./builtin/browserScreenshotTool";
import { browserSearchTool } from "./builtin/browserSearchTool";
import { browserSelectTargetTool } from "./builtin/browserSelectTargetTool";
import { browserSwitchTabTool } from "./builtin/browserSwitchTabTool";
import { browserTabsTool } from "./builtin/browserTabsTool";
import { browserTypeTool } from "./builtin/browserTypeTool";
import { browserWaitForTool } from "./builtin/browserWaitForTool";
import { clipboardReadTool } from "./builtin/clipboardReadTool";
import { clipboardWriteTool } from "./builtin/clipboardWriteTool";
import { desktopRevealPathTool } from "./builtin/desktopRevealPathTool";
import { desktopOpenKnownLocationTool } from "./builtin/desktopOpenKnownLocationTool";
import { echoTool } from "./builtin/echoTool";
import { fileDownloadToTempTool } from "./builtin/fileDownloadToTempTool";
import { fileDownloadMediaPageTool } from "./builtin/fileDownloadMediaPageTool";
import { filePlaceDownloadTool } from "./builtin/filePlaceDownloadTool";
import { fileVerifyTool } from "./builtin/fileVerifyTool";
import { fileListDirectoryTool } from "./builtin/fileListDirectoryTool";
import { fileReadTextTool } from "./builtin/fileReadTextTool";
import { fileCreateDirectoryTool } from "./builtin/fileCreateDirectoryTool";
import { fileMoveTool } from "./builtin/fileMoveTool";
import { hasTool, registerTool } from "./toolRegistry";

/**
 * 幂等注册内置工具。可在应用启动或首次跑任务时调用。
 * 以注册表实际内容为准，避免 clearToolRegistry 后无法再次挂载。
 */
export function registerBuiltinTools() {
  const tools = [
    echoTool,
    browserOpenTool,
    browserSearchTool,
    browserReadResultTool,
    browserScreenshotTool,
    browserSelectTargetTool,
    browserRevealInSystemBrowserTool,
    browserClickTool,
    browserTypeTool,
    browserWaitForTool,
    browserExtractTool,
    browserTabsTool,
    browserSwitchTabTool,
    clipboardReadTool,
    clipboardWriteTool,
    desktopRevealPathTool,
    desktopOpenKnownLocationTool,
    fileDownloadToTempTool,
    fileDownloadMediaPageTool,
    filePlaceDownloadTool,
    fileVerifyTool,
    fileListDirectoryTool,
    fileReadTextTool,
    fileCreateDirectoryTool,
    fileMoveTool
  ] as const;

  for (const tool of tools) {
    if (!hasTool(tool.name)) {
      registerTool(tool);
    }
  }
}
