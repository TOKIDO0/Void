// 浏览器工具桥接与端到端子系统出口。

export {
  browserOpen,
  browserReadResult,
  browserScreenshot,
  browserSearch,
  closeBrowserSession,
  ensureBrowserSession,
  getBrowserBridgeErrorInfo
} from "./browserBridgeClient";

export type {
  BrowserCloseSessionData,
  BrowserOpenData,
  BrowserReadResultData,
  BrowserScreenshotData,
  BrowserSearchData,
  BrowserSearchResultItem
} from "./browserBridgeTypes";

export { releaseBrowserSessionForTask } from "./browserSessionLifecycle";
export {
  runBrowserSearchTask
} from "./runBrowserSearchTask";
export type {
  BrowserSearchTaskOptions,
  BrowserSearchTaskResult,
  BrowserSearchTaskStructuredResult
} from "./runBrowserSearchTask";

export {
  runBrowserAssistSampleTask
} from "./runBrowserAssistSampleTask";
export type {
  BrowserAssistSampleTaskOptions,
  BrowserAssistSampleTaskResult,
  BrowserAssistSampleStructuredResult
} from "./runBrowserAssistSampleTask";
