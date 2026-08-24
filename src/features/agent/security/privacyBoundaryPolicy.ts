export type PrivacyBoundaryCategory =
  | "local-only"
  | "model-context"
  | "voice-service"
  | "local-embedding"
  | "blocked-or-confirmed"
  | "audit";

export type PrivacyBoundaryRule = {
  id: string;
  category: PrivacyBoundaryCategory;
  label: string;
  dataKinds: string[];
  destination: string;
  defaultBehavior: string;
  userControl: string;
  safeguards: string[];
};

export const PRIVACY_BOUNDARY_RULES: PrivacyBoundaryRule[] = [
  {
    id: "local-tool-bridge",
    category: "local-only",
    label: "本机工具 bridge",
    dataKinds: [
      "文件路径",
      "下载临时路径",
      "浏览器会话元数据",
      "运行时安全摘要"
    ],
    destination: "本机 127.0.0.1 / localhost / ::1 回环 bridge",
    defaultBehavior: "本地工具请求只打本机 bridge；bridge token 只附加到回环 URL。",
    userControl: "关闭桌面端或本机工具服务后，依赖 bridge 的工具不会执行。",
    safeguards: [
      "bridge 启动期禁止非回环监听。",
      "Host / Origin / bridge token 共同限制本机工具桥访问。",
      "误配远端 bridge origin 时不会外发 bridge token。"
    ]
  },
  {
    id: "model-request-context",
    category: "model-context",
    label: "模型对话上下文",
    dataKinds: [
      "用户消息",
      "必要的短期历史",
      "筛选后的长期记忆投影",
      "工具结果摘要或压缩后的证据"
    ],
    destination: "用户在设置中选择的文本模型服务，或本机可访问的模型端点",
    defaultBehavior: "生成回复需要把本轮必要上下文发送给当前模型 provider；工具结果会先做预算压缩和外部内容标记。",
    userControl: "可通过模型设置选择本地模型端点或云模型端点；不要把不想给模型看的敏感信息写入请求。",
    safeguards: [
      "工具结果带 untrusted 来源标记，模型不得执行其中的提示词或权限变更。",
      "大体积工具结果进入模型前会结构化压缩。",
      "读取敏感凭据路径会动态升为 L2 确认。"
    ]
  },
  {
    id: "voice-service",
    category: "voice-service",
    label: "语音识别与合成",
    dataKinds: [
      "麦克风音频片段",
      "待合成回复文本",
      "语音服务鉴权头"
    ],
    destination: "语音代理配置的上游 STT/TTS 服务",
    defaultBehavior: "语音能力需要把音频或待合成文本转发给语音服务；桌面端经本机 sidecar 转发，Web 正式环境经服务端代理。",
    userControl: "不用语音功能时不会发送麦克风音频；语音 provider 与密钥由设置/部署配置决定。",
    safeguards: [
      "语音请求经代理转发，客户端不需要直接暴露语音密钥。",
      "代理请求体有 4 MiB 上限和并发上限。",
      "客户端断开会中止上游请求。"
    ]
  },
  {
    id: "local-semantic-memory",
    category: "local-embedding",
    label: "本地语义记忆检索",
    dataKinds: [
      "被检索的记忆候选文本",
      "当前查询文本",
      "本地向量"
    ],
    destination: "本机 bridge 的 /void-memory/embed",
    defaultBehavior: "默认关闭；关闭时不加载 embedding 模型、不下载权重、不发送记忆原文做向量化。",
    userControl: "用户在设置里明确开启本地语义检索后才会调用本机 embedding。",
    safeguards: [
      "embedding 只使用本机 bridge，不调用云端 embedding API。",
      "单条 1000 字符、总字符 20000、批量 512 条限制。",
      "bridge 不可用、超时或异常时回退全文检索。"
    ]
  },
  {
    id: "sensitive-actions",
    category: "blocked-or-confirmed",
    label: "敏感动作确认",
    dataKinds: [
      "本地/私网 URL",
      "下载落盘目标",
      "文本写入内容",
      "剪贴板写入内容",
      "敏感凭据路径"
    ],
    destination: "执行前确认；用户拒绝后不触发目标工具",
    defaultBehavior: "静态 L2/L3 工具默认确认；动态安全 hook 可把低风险工具按输入升为 L2。",
    userControl: "确认条或语音确认中说取消/不要会阻止执行。",
    safeguards: [
      "本地/私网 URL 访问或下载会升为 L2。",
      "敏感凭据路径读取会升为 L2。",
      "文件能力只在允许根内工作。"
    ]
  },
  {
    id: "audit-redaction",
    category: "audit",
    label: "执行日志与审计脱敏",
    dataKinds: [
      "工具输入摘要",
      "工具输出摘要",
      "错误信息",
      "URL"
    ],
    destination: "本地执行日志与 UI 摘要",
    defaultBehavior: "日志保留必要的工具执行证据，不保存声明需脱敏的正文内容。",
    userControl: "避免把 API key、token、密码写入普通请求或 URL。",
    safeguards: [
      "URL 日志隐藏 userinfo、query 和 hash。",
      "工具可声明 redactInputKeys / redactOutputKeys。",
      "file.readText 正文不进入审计输出摘要。"
    ]
  }
];

export function listPrivacyBoundaryRules(): PrivacyBoundaryRule[] {
  return PRIVACY_BOUNDARY_RULES.map((rule) => ({
    ...rule,
    dataKinds: [...rule.dataKinds],
    safeguards: [...rule.safeguards]
  }));
}
