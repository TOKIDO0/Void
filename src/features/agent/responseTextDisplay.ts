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
  const withoutStageDirections = text
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

  return normalizeMarkdownForDisplay(withoutStageDirections);
}

/**
 * VOID 是语音优先界面：把模型常见 Markdown 控制语法转成可直接显示和朗读的中文文本。
 * 只处理结构明确的标记，不全局删除星号，避免破坏乘法、文件通配符和代码内容。
 */
export function normalizeMarkdownForDisplay(text: string): string {
  return text
    // 代码围栏仅去掉围栏本身，保留内部正文。
    .replace(/^\s*```[^\n]*$/gm, "")
    // Markdown 标题、引用和装饰性分隔线。
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, "")
    // 无序列表使用中文间隔点；有序列表保留原序号但改为中文顿号。
    .replace(/^\s*[-+*]\s+/gm, "· ")
    .replace(/^\s*(\d+)[.)]\s+/gm, "$1、")
    // 粗体代表强调，转换为用户指定的中文引号；斜体只保留正文。
    .replace(/\*\*([^*\n]+)\*\*/g, "“$1”")
    .replace(/__([^_\n]+)__/g, "“$1”")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2")
    .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1$2")
    // 行内代码只去掉反引号，内容继续显示。
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
