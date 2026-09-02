// 工具系统契约类型（唯一真源）。
// 设计依据：`.md/27_VOID_Agent工具系统与多窗口协作架构文档.md` §4.1 / §5.1。

/**
 * 风险等级：决定默认是否需要用户确认。
 * L0 只读自动；L1 可逆自动并记录；L2 敏感需确认；L3 高风险每次确认。
 */
export type RiskLevel = "L0" | "L1" | "L2" | "L3";

/**
 * 幂等语义：重复执行是否安全。
 */
export type ToolIdempotency = "safe" | "unsafe" | "unknown";

/**
 * 轻量 JSON Schema 子集：阶段 B 只支持校验所需的字段，避免引入重量级依赖。
 */
export type ToolJsonSchema = {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array" | "null";
  description?: string;
  properties?: Record<string, ToolJsonSchema>;
  required?: string[];
  anyOf?: ToolJsonSchema[];
  additionalProperties?: boolean;
  items?: ToolJsonSchema;
  enum?: Array<string | number | boolean | null>;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

/**
 * 工具声明的资源需求（阶段 B 最小集；后续浏览器/文件/账户再扩展）。
 */
export type ToolResourceRequirement = {
  /** 资源类别，例如 memory / browser / file / network */
  kind: string;
  /** 稳定资源键；同一 key 在单写/独占模式下互斥 */
  key: string;
  /** shared=可并行；exclusive=单写/独占 */
  mode: "shared" | "exclusive";
};

/**
 * 审计策略：决定日志如何脱敏。
 */
export type ToolAuditPolicy = {
  /** 输入中需要脱敏的字段名 */
  redactInputKeys?: string[];
  /** 输出中需要脱敏的字段名 */
  redactOutputKeys?: string[];
  /** 是否允许记录完整入参摘要（仍会走脱敏） */
  logInputSummary?: boolean;
  /** 是否允许记录完整出参摘要（仍会走脱敏） */
  logOutputSummary?: boolean;
};

/**
 * 单次工具调用上下文：由执行器注入，工具实现不得自行伪造。
 */
export type ToolCallContext = {
  taskId: string;
  stepId: string;
  /** 任务级取消信号 */
  signal: AbortSignal;
  /** 当前步骤开始时间（epoch ms） */
  startedAt: number;
};

/**
 * 分类错误码：执行器按码决定是否重试、是否上报。
 */
export type ToolErrorCode =
  | "TOOL_NOT_FOUND"
  | "TOOL_DISABLED"
  | "SCHEMA_INVALID"
  | "OUTPUT_SCHEMA_INVALID"
  | "PERMISSION_DENIED"
  | "CONFIRMATION_REQUIRED"
  | "CONFIRMATION_REJECTED"
  | "RESOURCE_BUSY"
  | "TIMEOUT"
  | "CANCELLED"
  | "RETRY_EXHAUSTED"
  | "DEPENDENCY_FAILED"
  | "EXECUTION_FAILED"
  | "INTERNAL_ERROR";

/**
 * 结构化工具错误。
 */
export type ToolError = {
  code: ToolErrorCode;
  message: string;
  /** 是否允许有限重试（超时/瞬时失败） */
  retriable: boolean;
  /** 可选细节，禁止放入密钥 */
  details?: Record<string, unknown>;
};

/**
 * 结构化工具结果：成功或失败二选一。
 */
export type ToolResult<TData = unknown> =
  | {
      ok: true;
      data: TData;
      /** 给用户/下一步消费的短摘要 */
      summary: string;
    }
  | {
      ok: false;
      error: ToolError;
    };

/**
 * 工具实现函数签名。
 */
export type ToolExecuteFn<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  context: ToolCallContext
) => Promise<TOutput>;

/**
 * 工具定义：注册表中的完整契约。
 * 模型只看 name/description/inputSchema；执行器强制校验其余字段。
 */
export type ToolDefinition<TInput = unknown, TOutput = unknown> = {
  name: string;
  description: string;
  version: string;
  riskLevel: RiskLevel;
  inputSchema: ToolJsonSchema;
  outputSchema: ToolJsonSchema;
  requiredResources: ToolResourceRequirement[];
  permissions: string[];
  timeoutMs: number;
  cancellable: boolean;
  idempotency: ToolIdempotency;
  auditPolicy: ToolAuditPolicy;
  /** 是否启用；禁用后注册表仍可见但执行器拒绝 */
  enabled?: boolean;
  /** 最大自动重试次数（不含首次）；默认 0 */
  maxRetries?: number;
  execute: ToolExecuteFn<TInput, TOutput>;
};

/**
 * 注册表对外暴露的只读元数据（不含 execute 函数）。
 */
export type ToolMetadata = Omit<ToolDefinition, "execute">;

/**
 * 待执行的工具调用请求（已进入计划后的一步）。
 */
export type ToolInvocationRequest = {
  toolName: string;
  input: unknown;
  stepId: string;
  taskId: string;
};
