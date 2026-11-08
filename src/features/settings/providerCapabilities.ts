/**
 * 模型多模态能力判定。
 *
 * 用途：附件（图片/PDF）发送前据此决定携带何种内容块，或走文本降级，
 * 避免给纯文本模型发 image/document 触发 400。
 *
 * 判定顺序（关键：能力是「部署属性」，不是模型名属性）：
 *   1. `declaredSupportsImage` —— 用户在设置里对本 preset 的显式声明，优先级最高。
 *   2. 未声明时，按 presetId + 模型名的厂商官方文档口径推断（首方直连场景足够准）。
 *
 * 为什么必须有显式声明：中转站/私有部署可以给任意模型名接上任意后端。
 * 实测 a6api 的 `deepseek-v4.1-flash` 能正确读出截图文字，但名字不含 vision，
 * 任何「按名字猜」的规则都会判错；反之官方 DeepSeek 同名纯文本模型也不能靠名字判活。
 * 因此名字推断只作为未声明时的默认值，不是真源。
 *
 * 官方口径（未声明时的默认推断依据）：
 *   - image：智谱 glm-*v* / 豆包 doubao-seed* / Anthropic claude-* / OpenAI gpt-*（视觉系）。
 *   - DeepSeek：官方仅 `-vision-` 变体支持图片，其余纯文本（官方 Vision 文档）。
 *   - pdf document 原生：仅 Anthropic；其余厂商 PDF 一律走本地文本抽取。
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
 *
 * @param declaredSupportsImage 用户在设置里显式声明的图片理解能力；
 *   传入 boolean 时直接采信（含 false），传入 undefined 才回落到名字推断。
 */
export function resolveModelMediaCapability(
  presetId: string,
  modelName: string,
  declaredSupportsImage?: boolean
): ModelMediaCapability {
  const model = modelName.trim().toLowerCase();

  if (typeof declaredSupportsImage === "boolean") {
    return {
      supportsImage: declaredSupportsImage,
      supportsPdfDocument: resolvePdfDocumentCapability(presetId)
    };
  }

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
      // 官方仅 `-vision-` 变体支持图片；中转站上的其他模型名需用户显式声明。
      return { supportsImage: model.includes("vision"), supportsPdfDocument: false };

    default:
      return TEXT_ONLY;
  }
}

/** PDF 原生 document 块仅 Anthropic 支持，与图片能力声明无关。 */
function resolvePdfDocumentCapability(presetId: string): boolean {
  return presetId === "anthropic";
}
