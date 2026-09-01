// 注册内置工具。真实工具与假工具都从这里挂载，不散落在 UI。

import { browserClickTool } from "./builtin/browserClickTool";
import { browserExtractTool } from "./builtin/browserExtractTool";
import { browserLongPressTool } from "./builtin/browserLongPressTool";
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
import { desktopListInstalledApplicationsTool } from "./builtin/desktopListInstalledApplicationsTool";
import { desktopLaunchApplicationTool } from "./builtin/desktopLaunchApplicationTool";
import { echoTool } from "./builtin/echoTool";
import { fileDownloadToTempTool } from "./builtin/fileDownloadToTempTool";
import { fileDownloadMediaPageTool } from "./builtin/fileDownloadMediaPageTool";
import { fileDownloadMediaTool } from "./builtin/fileDownloadMediaTool";
import { filePlaceDownloadTool } from "./builtin/filePlaceDownloadTool";
import { fileVerifyTool } from "./builtin/fileVerifyTool";
import { fileListDirectoryTool } from "./builtin/fileListDirectoryTool";
import { fileInspectPathTool } from "./builtin/fileInspectPathTool";
import { fileFindByNameTool } from "./builtin/fileFindByNameTool";
import { fileListRecentArtifactsTool } from "./builtin/fileListRecentArtifactsTool";
import { fileReadTextTool } from "./builtin/fileReadTextTool";
import { fileSearchTextTool } from "./builtin/fileSearchTextTool";
import { fileInspectWriteTargetTool } from "./builtin/fileInspectWriteTargetTool";
import { fileCreateDirectoryTool } from "./builtin/fileCreateDirectoryTool";
import { fileMoveTool } from "./builtin/fileMoveTool";
import { fileWriteTextTool } from "./builtin/fileWriteTextTool";
import { securityInspectLocalRuntimeTool } from "./builtin/securityInspectLocalRuntimeTool";
import { softwareListSupportedTool } from "./builtin/softwareListSupportedTool";
import { softwareResolveInstallerTool } from "./builtin/softwareResolveInstallerTool";
import { softwareDownloadInstallerTool } from "./builtin/softwareDownloadInstallerTool";
import { agentInspectCapabilitiesTool } from "./builtin/agentInspectCapabilitiesTool";
import { agentPlanTaskRouteTool } from "./builtin/agentPlanTaskRouteTool";
import { agentInspectToolContractTool } from "./builtin/agentInspectToolContractTool";
import { agentInspectExtensionPolicyTool } from "./builtin/agentInspectExtensionPolicyTool";
import { agentInspectSkillsTool } from "./builtin/agentInspectSkillsTool";
import { agentInspectMemoryVerificationTool } from "./builtin/agentInspectMemoryVerificationTool";
import { agentInspectSafetyHooksTool } from "./builtin/agentInspectSafetyHooksTool";
import { agentInspectPrivacyBoundariesTool } from "./builtin/agentInspectPrivacyBoundariesTool";
import { agentInspectTaskPlaybooksTool } from "./builtin/agentInspectTaskPlaybooksTool";
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
    browserLongPressTool,
    browserTypeTool,
    browserWaitForTool,
    browserExtractTool,
    browserTabsTool,
    browserSwitchTabTool,
    clipboardReadTool,
    clipboardWriteTool,
    desktopRevealPathTool,
    desktopOpenKnownLocationTool,
    desktopListInstalledApplicationsTool,
    desktopLaunchApplicationTool,
    fileDownloadToTempTool,
    fileDownloadMediaPageTool,
    fileDownloadMediaTool,
    filePlaceDownloadTool,
    fileVerifyTool,
    fileListDirectoryTool,
    fileInspectPathTool,
    fileFindByNameTool,
    fileListRecentArtifactsTool,
    fileReadTextTool,
    fileSearchTextTool,
    fileInspectWriteTargetTool,
    fileCreateDirectoryTool,
    fileMoveTool,
    fileWriteTextTool,
    securityInspectLocalRuntimeTool,
    softwareListSupportedTool,
    softwareResolveInstallerTool,
    softwareDownloadInstallerTool,
    agentInspectCapabilitiesTool,
    agentPlanTaskRouteTool,
    agentInspectToolContractTool,
    agentInspectExtensionPolicyTool,
    agentInspectSafetyHooksTool,
    agentInspectPrivacyBoundariesTool,
    agentInspectTaskPlaybooksTool,
    agentInspectSkillsTool,
    agentInspectMemoryVerificationTool
  ] as const;

  for (const tool of tools) {
    if (!hasTool(tool.name)) {
      registerTool(tool);
    }
  }
}
