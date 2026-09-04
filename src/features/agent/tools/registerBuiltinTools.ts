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
import { desktopListWindowsTool } from "./builtin/desktopListWindowsTool";
import { desktopFocusWindowTool } from "./builtin/desktopFocusWindowTool";
import { desktopCloseWindowTool } from "./builtin/desktopCloseWindowTool";
import { desktopGetSystemInfoTool } from "./builtin/desktopGetSystemInfoTool";
import { desktopScreenshotTool } from "./builtin/desktopScreenshotTool";
import { desktopSetWindowBoundsTool } from "./builtin/desktopSetWindowBoundsTool";
import { desktopOpenFileTool } from "./builtin/desktopOpenFileTool";
import { desktopInspectWindowControlsTool } from "./builtin/desktopInspectWindowControlsTool";
import { desktopSetControlTextTool } from "./builtin/desktopSetControlTextTool";
import { desktopInvokeControlTool } from "./builtin/desktopInvokeControlTool";
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
import { fileEditTextTool } from "./builtin/fileEditTextTool";
import { fileOrganizeDirectoryTool } from "./builtin/fileOrganizeDirectoryTool";
import { fileCreateExcelTool } from "./builtin/fileCreateExcelTool";
import { fileCreatePptxTool } from "./builtin/fileCreatePptxTool";
import { fileCreateDocxTool } from "./builtin/fileCreateDocxTool";
import { securityInspectLocalRuntimeTool } from "./builtin/securityInspectLocalRuntimeTool";
import { softwareListSupportedTool } from "./builtin/softwareListSupportedTool";
import { softwareResolveInstallerTool } from "./builtin/softwareResolveInstallerTool";
import { softwareDownloadInstallerTool } from "./builtin/softwareDownloadInstallerTool";
import { agentInspectCapabilitiesTool } from "./builtin/agentInspectCapabilitiesTool";
import { agentPlanTaskRouteTool } from "./builtin/agentPlanTaskRouteTool";
import { agentScheduleCreateTool } from "./builtin/agentScheduleCreateTool";
import { agentScheduleListTool } from "./builtin/agentScheduleListTool";
import { agentScheduleRemoveTool } from "./builtin/agentScheduleRemoveTool";
import { agentScheduleRunNowTool } from "./builtin/agentScheduleRunNowTool";
import { agentScheduleInspectTool } from "./builtin/agentScheduleInspectTool";
import { desktopTakeoverStartTool } from "./builtin/desktopTakeoverStartTool";
import { desktopTakeoverStopTool } from "./builtin/desktopTakeoverStopTool";
import { desktopTakeoverInputTool } from "./builtin/desktopTakeoverInputTool";
import { desktopTakeoverStatusTool } from "./builtin/desktopTakeoverStatusTool";
import { desktopReadScreenTextTool } from "./builtin/desktopReadScreenTextTool";
import { agentInspectToolContractTool } from "./builtin/agentInspectToolContractTool";
import { agentInspectExtensionPolicyTool } from "./builtin/agentInspectExtensionPolicyTool";
import { agentInspectSkillsTool } from "./builtin/agentInspectSkillsTool";
import { agentInspectMemoryVerificationTool } from "./builtin/agentInspectMemoryVerificationTool";
import { agentInspectSafetyHooksTool } from "./builtin/agentInspectSafetyHooksTool";
import { agentInspectPrivacyBoundariesTool } from "./builtin/agentInspectPrivacyBoundariesTool";
import { agentInspectTaskPlaybooksTool } from "./builtin/agentInspectTaskPlaybooksTool";
import { agentInspectWorkspaceTool } from "./builtin/agentInspectWorkspaceTool";
import { webSearchTool } from "./builtin/webSearchTool";
import { webFetchTool } from "./builtin/webFetchTool";
import { agentTodoTool } from "./builtin/agentTodoTool";
import { agentGoalTool } from "./builtin/agentGoalTool";
import { agentAskUserTool } from "./builtin/agentAskUserTool";
import { agentSpawnTaskTool } from "./builtin/agentSpawnTaskTool";
import { agentRunCodeTool } from "./builtin/agentRunCodeTool";
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
    desktopListWindowsTool,
    desktopFocusWindowTool,
    desktopCloseWindowTool,
    desktopGetSystemInfoTool,
    desktopScreenshotTool,
    desktopSetWindowBoundsTool,
    desktopOpenFileTool,
    desktopInspectWindowControlsTool,
    desktopSetControlTextTool,
    desktopInvokeControlTool,
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
    fileEditTextTool,
    fileOrganizeDirectoryTool,
    fileCreateExcelTool,
    fileCreatePptxTool,
    fileCreateDocxTool,
    securityInspectLocalRuntimeTool,
    softwareListSupportedTool,
    softwareResolveInstallerTool,
    softwareDownloadInstallerTool,
    agentInspectCapabilitiesTool,
    agentPlanTaskRouteTool,
    agentScheduleCreateTool,
    agentScheduleListTool,
    agentScheduleRemoveTool,
    agentScheduleRunNowTool,
    agentScheduleInspectTool,
    desktopTakeoverStartTool,
    desktopTakeoverStopTool,
    desktopTakeoverInputTool,
    desktopTakeoverStatusTool,
    desktopReadScreenTextTool,
    agentInspectToolContractTool,
    agentInspectExtensionPolicyTool,
    agentInspectSafetyHooksTool,
    agentInspectPrivacyBoundariesTool,
    agentInspectTaskPlaybooksTool,
    agentRunCodeTool,
    agentInspectWorkspaceTool,
    webSearchTool,
    webFetchTool,
    agentTodoTool,
    agentGoalTool,
    agentAskUserTool,
    agentSpawnTaskTool,
    agentInspectSkillsTool,
    agentInspectMemoryVerificationTool
  ] as const;

  for (const tool of tools) {
    if (!hasTool(tool.name)) {
      registerTool(tool);
    }
  }
}
