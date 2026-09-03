// P2 agent.askUser：一句话澄清闭环（对标 Claude AskUser）。
// 模型拿不准且必须用户拍板时调用：一次最多 3 问，工具回灌后模型用自然中文提问，
// 用户回答后继续原任务。只做结构化透传，不弹窗、不阻塞执行器。

import type { ToolDefinition } from "../toolTypes";

export type AgentAskUserQuestion = {
  id?: string;
  question: string;
  options?: string[];
};

export type AgentAskUserToolInput = {
  questions: AgentAskUserQuestion[];
  context?: string;
};

export type AgentAskUserToolOutput = {
  status: "ok";
  questions: Array<{ id: string; question: string; options: string[] }>;
  guidance: string;
  askedAt: number;
};

const MAX_QUESTIONS = 3;
const MAX_QUESTION_CHARS = 300;
const MAX_OPTIONS = 4;
const MAX_OPTION_CHARS = 80;

export const agentAskUserTool: ToolDefinition<AgentAskUserToolInput, AgentAskUserToolOutput> = {
  name: "agent.askUser",
  description:
    "向用户澄清关键分歧：一次最多 3 个问题（优先只问最关键的一个），可带 2-4 个候选项。调用后请用自然中文向用户提问，用户回答后再继续原任务；禁止把问题藏进长篇大论。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["questions"],
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: MAX_QUESTIONS,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["question"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 40 },
            question: { type: "string", minLength: 1, maxLength: MAX_QUESTION_CHARS },
            options: {
              type: "array",
              minItems: 2,
              maxItems: MAX_OPTIONS,
              items: { type: "string", minLength: 1, maxLength: MAX_OPTION_CHARS }
            }
          }
        }
      },
      context: { type: "string", minLength: 1, maxLength: 300 }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["status", "questions", "guidance", "askedAt"],
    properties: {
      status: { type: "string", enum: ["ok"] },
      questions: {
        type: "array",
        maxItems: MAX_QUESTIONS,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "question", "options"],
          properties: {
            id: { type: "string" },
            question: { type: "string" },
            options: { type: "array", items: { type: "string" } }
          }
        }
      },
      guidance: { type: "string", maxLength: 300 },
      askedAt: { type: "number" }
    }
  },
  requiredResources: [],
  permissions: ["tool.agent.askUser"],
  timeoutMs: 3_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input) {
    const questions = input.questions.map((item, index) => ({
      id: item.id?.trim() || `q${index + 1}`,
      question: item.question.trim(),
      options: (item.options ?? []).map((option) => option.trim()).filter(Boolean).slice(0, MAX_OPTIONS)
    }));
    return {
      status: "ok",
      questions,
      guidance:
        "请用自然中文向用户提出上面这些问题，一次只问最关键的一个并给出候选项；用户回答后再继续原任务，不要重复追问已问过的问题。",
      askedAt: Date.now()
    };
  }
};
