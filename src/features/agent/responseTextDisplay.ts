// 回复文本显示层净化：剥离 AI 回复里形如「（我停顿了一下）」的情绪/动作旁白，
// 但保留术语解释括号（如 RAG（Retrieval-Augmented Generation，检索增强生成））。
//
// 设计依据：`.md/20_VOID_情绪语音连贯性与活人感专项方案.md` 第 3 节。
// 判定不靠语义，靠结构——旁白括号整段独占一行、或位于行首其后另起正文；
// 术语括号则句内紧贴前面的词。只剥离「独立成行的括号段」与「行首的括号段」，
// 其余括号（句中、词后）一律保留，从而零误伤术语括号。
//
// 与 TTS 的 sanitizeTextForSpeech 分工：那个无差别剥全部括号（供合成，不影响显示）；
// 本函数供显示层，须精细区分旁白与术语。二者互不复用，各自单一职责。
export function stripStageDirections(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmedLine = line.trim();
      // 整行仅为一对括号包裹的内容（前后无其他文字）→ 判定为旁白，整行剥除
      if (/^（[^（）]*）$/.test(trimmedLine) || /^\([^()]*\)$/.test(trimmedLine)) {
        return "";
      }
      // 行首的括号旁白（其后还有正文）→ 只剥行首这一段，正文保留
      return line
        .replace(/^\s*（[^（）]*）\s*/, "")
        .replace(/^\s*\([^()]*\)\s*/, "");
    })
    // 剥离后产生的连续空行折叠为一个，避免显示层出现大段空白
    .filter((line, index, lines) => line.trim() !== "" || (index > 0 && lines[index - 1].trim() !== ""))
    .join("\n")
    .trim();
}
