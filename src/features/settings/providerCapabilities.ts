/**
 * 模型多模态能力判定。
 *
 * 用途：附件（图片/PDF）发送前据此决定携带何种内容块，或走文本降级，
 * 避免给纯文本模型发 image/document 触发 400。判定按「presetId + 模型名」双重匹配。
 *
 * 判定依据（见 36 号方案 D.3，均来自各厂商官方文档）：
 *   - image：智谱 glm-*v* / 豆包 doubao-seed* / Anthropic claude-* / OpenAI gpt-*（视觉系）。
 *   - DeepSeek：仅 deepseek-v4-flash-vision-exp（含 vision 标识）支持图片，其余纯文本下（官方 Vision 文档）。
 *   - pdf document 原生：仅 Anthropic；其余厂商 PDF 一律走本地文本抽取。
 *   - DeepSeek 全系无 vision → 文本降级。
 */

export type ModelMediaCapability = {
  /** 能否直接把图片作为 content 块送达模型。 */
  supportsImage: boolean;
  /** 能否把 PDF 作为原生 document 块送达（否则需本地抽取文本）。 */
  supportsPdfDocument: boolean;
};

const TEXT_ONLY: ModelMediaCapability = {
  supportsImage: false,
  supportsPdfDocument: false
};

/**
 * 判定给定 preset + 模型名的多模态能力。
 * 模型名统一转小写比较，兼容带日期/版本后缀（如 doubao-seed-1-6-250615）。
 */
export function resolveModelMediaCapability(presetId: string, modelName: string): ModelMediaCapability {
  const model = modelName.trim().toLowerCase();

  switch (presetId) {
    case "anthropic":
      // Claude 全系支持图片；PDF 原生 document 块。
      return { supportsImage: model.startsWith("claude-"), supportsPdfDocument: true };

    case "zhipu":
      // 智谱视觉模型：glm-4v / glm-4.6v 等含 "v" 视觉标识。
      return { supportsImage: /glm-[\d.]*v/.test(model), supportsPdfDocument: false };

    case "doubao":
      // 豆包视觉：doubao-seed / doubao-vision 系列。
      return {
        supportsImage: model.includes("seed") || model.includes("vision"),
        supportsPdfDocument: false
      };

    case "openai":
      // GPT-4o / GPT-5 系视觉；老 gpt-3.5 无视觉。
      return {
        supportsImage: /gpt-(4o|4\.1|5|5\.\d)/.test(model) || model.includes("vision"),
        supportsPdfDocument: false
      };

    case "deepseek":
      // 仅 deepseek-v4-flash-vision-exp（含 vision 标识）支持图片；其余纯文本降级。
      return { supportsImage: model.includes("vision"), supportsPdfDocument: false };

    default:
      return TEXT_ONLY;
  }
}
