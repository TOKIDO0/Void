/// <reference types="vite/client" />

// mammoth 浏览器构建无类型声明，仅用到 extractRawText，按需最小声明。
declare module "mammoth/mammoth.browser" {
  export function extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<{
    value: string;
    messages: unknown[];
  }>;
  const mammoth: { extractRawText: typeof extractRawText };
  export default mammoth;
}
