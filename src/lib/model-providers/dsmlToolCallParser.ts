// 正文内工具协议解析与剥离（单一真源）。
// 根因：部分 OpenAI-compatible 模型（如 deepseek 系经中转）会把工具调用以 DSML
// 文本写进 content，而 message.tool_calls 为空。若不处理，协议原文会直达用户
// 显示与 TTS 朗读。设计：provider 层解析成真 tool_calls 去执行；循环层兜底；
// 显示/TTS 层剥离。三层共用本文件，禁止各写一套正则漂移。
//
// 线上实测两种线格式：单竖线 <|DSML|invoke …|> 与双竖线 <||DSML||invoke …||>。
// 以下全部正则按“竖线 1 到多根 + 任意空白”编写，新变体不得另起正则。

export type ParsedDsmlCall = {
  name: string;
  args: Record<string, unknown>;
};

function parseAttrs(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w][\w.-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrText)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

/** 是否含正文内工具协议（DSML 或通用 tool_calls 标记）。 */
export function hasProtocolMarkup(content: string): boolean {
  if (!content) {
    return false;
  }
  return (
    /<\|+\s*\/?\s*\|*\s*DSML/i.test(content)
    || /<\s*\/?\s*(tool_calls|function_calls)\b/i.test(content)
  );
}

/**
 * 解析 DSML invoke 块为结构化调用。竖线 1 到多根、任意空白均可
 * （如 <||DSML||invoke …||>、</|DSML||invoke>）。失败返回 []，绝不抛错。
 */
export function parseDsmlToolCalls(content: string): ParsedDsmlCall[] {
  const calls: ParsedDsmlCall[] = [];
  if (!content || !content.includes("DSML")) {
    return calls;
  }
  const openRe = /<\|+\s*DSML\s*\|+\s*invoke\b([^>]*)>/gi;
  const closeRe = /<\|+\s*\/\s*DSML\s*\|+[^>]*invoke[^>]*>/i;
  const paramRe = /<\|+\s*DSML\s*\|+\s*parameter\b([^>]*)>([\s\S]*?)<\|+\s*\/\s*DSML\s*\|+[^>]*parameter[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(content)) !== null) {
    const name = (parseAttrs(m[1] ?? "").name ?? "").trim();
    if (!name) {
      continue;
    }
    const rest = content.slice(m.index + m[0].length);
    const cm = closeRe.exec(rest);
    const inner = cm ? rest.slice(0, cm.index) : rest;
    const args: Record<string, unknown> = {};
    let pm: RegExpExecArray | null;
    paramRe.lastIndex = 0;
    while ((pm = paramRe.exec(inner)) !== null) {
      const key = (parseAttrs(pm[1] ?? "").name ?? "").trim();
      if (!key) {
        continue;
      }
      args[key] = (pm[2] ?? "").trim();
    }
    calls.push({ name, args });
    if (cm) {
      openRe.lastIndex = m.index + m[0].length + cm.index + cm[0].length;
    }
  }
  return calls;
}

/**
 * 剥离正文内全部工具协议（整块删除），保留人类可读正文。
 * 供显示层、TTS 与循环层兜底共用。
 */
export function stripProtocolMarkup(content: string): string {
  if (!content) {
    return "";
  }
  let out = content;
  // DSML invoke 整块（含内部参数）
  out = out.replace(
    /<\|+\s*DSML\s*\|+\s*invoke\b[^>]*>[\s\S]*?<\|+\s*\/\s*DSML\s*\|+[^>]*invoke[^>]*>/gi,
    ""
  );
  // DSML tool_calls 包裹标记
  out = out.replace(/<\|+\s*\/?\s*DSML\s*\|+[^>]*tool_calls[^>]*>/gi, "");
  // 残留的 DSML 散标记
  out = out.replace(/<\|+\s*\/?\s*\|*\s*DSML[^>]*>/gi, "");
  // 通用 <tool_calls>/<function_calls> 整块与散标记
  out = out.replace(/<\s*(tool_calls|function_calls)\s*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  out = out.replace(/<\s*\/?\s*(tool_calls|function_calls|tool_call|function_call)\s*>/gi, "");
  // 折叠剥离产生的连续空行
  out = out
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, index, arr) => line.trim() !== "" || (index > 0 && arr[index - 1].trim() !== ""))
    .join("\n")
    .trim();
  return out;
}
