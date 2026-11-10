/**
 * 语音合成分块（唯一真源）。
 *
 * 渐进式分块：首块尽量短以最小化首字发声延迟（TTFA）；后续块合并 2–3 句再合成。
 *
 * 业界口径（ElevenLabs / Cartesia / Deepgram / Qwen3-TTS 维护者）：
 * - 块必须以整句标点收尾，否则模型会把半句当完整句，尾部出现怪音；
 * - 单次生成越长越容易“后段加速、停顿被压缩”（Qwen3-TTS 已知漂移）；
 * - 因此不要把块拉长到 90 字以上，也不要让弱标点（逗号）成为常规切分点。
 */

// 数组按「本轮已产出的合成块序号」取阈值，越靠后越长，末位为封顶值。
// 实测（scripts/tts-ttfa-probe.ts）：生成 RTF ≈ 1.8，串行生成追不上播放，
// 空洞大小与块音频时长成正比。回收到 8–18 / 18–30 字，把单次空洞从 5–10s 压到约 1.5s。
const SYNTHESIS_CHUNK_MIN_CHARS_RAMP = [8, 18, 30];
// 软切封顶：无强标点时（异常长句）才允许在弱停顿处切，正常路径应落在句末标点。
const SYNTHESIS_CHUNK_SOFT_FLUSH_CHARS = 72;
// 单块最多合并几整句：短句（如「好的。」）不会因为没有标点就一直并块。
const MAX_SENTENCES_PER_CHUNK = 3;
// 首块硬上限：没有任何标点的长句也必须尽快开口，避免首句被整段合成拖到 6–7 秒。
// 只在中日韩字符/空格处硬切，不切断英文单词。
const SYNTHESIS_FIRST_CHUNK_MAX_CHARS = 18;

export type ReadySentences = {
  /** 已就绪、可立即送入合成的块 */
  sentences: string[];
  /** 本次从入参文本中消费掉的字符数，供流式游标推进 */
  consumedLength: number;
};

function resolveChunkMinChars(chunkIndex: number) {
  const rampIndex = Math.min(chunkIndex, SYNTHESIS_CHUNK_MIN_CHARS_RAMP.length - 1);
  return SYNTHESIS_CHUNK_MIN_CHARS_RAMP[rampIndex];
}

/**
 * 从流式文本中切出「已就绪」的合成块。
 * @param includeRemainder 收尾时为 true，把剩余不足一块的尾巴也一并吐出
 * @param emittedChunkOffset 本轮此前已产出的合成块数量，用于渐进式阈值定位（首块最短）
 */
export function extractReadySentences(
  text: string,
  includeRemainder: boolean,
  emittedChunkOffset = 0
): ReadySentences {
  const sentences: string[] = [];
  let consumedLength = 0;
  let chunkStartIndex = 0;
  // 括号嵌套深度：进入括号内不切句，保证成对括号（含内部标点）整体落在同一块，
  // 之后 sanitizeTextForSpeech 才能把旁白整体剥离，避免旁白被切散后残留文字被朗读。
  let bracketDepth = 0;
  // 当前块内已遇强标点（整句结束）次数：达到句数上限即收口，保证块长不失控。
  let strongBoundariesInChunk = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (isOpenBracket(character)) {
      bracketDepth += 1;
    } else if (isCloseBracket(character) && bracketDepth > 0) {
      bracketDepth -= 1;
    }

    const isStrongBoundary = isSentenceDelimiter(character);
    const isSoftBoundary = isSoftSentenceDelimiter(character);
    const globalChunkIndex = emittedChunkOffset + sentences.length;
    const currentChunkLength = index + 1 - chunkStartIndex;
    const isCjkCharacter = /[\u3400-\u9fff]/.test(character);
    // 首块没有标点时也要硬切，保证 TTFA 不被整句合成拖住。
    if (
      globalChunkIndex === 0
      && currentChunkLength >= SYNTHESIS_FIRST_CHUNK_MAX_CHARS
      && bracketDepth === 0
      && (isCjkCharacter || character === " ")
    ) {
      const hardChunk = text.slice(chunkStartIndex, index + 1).trim();
      if (hardChunk) {
        sentences.push(hardChunk);
        strongBoundariesInChunk = 0;
        chunkStartIndex = index + 1;
        consumedLength = index + 1;
      }
      continue;
    }

    if (!isStrongBoundary && !isSoftBoundary) {
      continue;
    }

    // 括号内的标点一律不作为切分边界；仅当块已超软切封顶（异常超长未闭合括号）才放弃保护，防卡死
    if (bracketDepth > 0 && currentChunkLength < SYNTHESIS_CHUNK_SOFT_FLUSH_CHARS) {
      continue;
    }

    const chunk = text.slice(chunkStartIndex, index + 1).trim();
    // 强标点计数：块内集满 MAX_SENTENCES_PER_CHUNK 句时立刻收口，避免短句被无限合并。
    if (isStrongBoundary) {
      strongBoundariesInChunk += 1;
    }
    const reachedSentenceCap =
      isStrongBoundary && strongBoundariesInChunk >= MAX_SENTENCES_PER_CHUNK;
    // 首块允许在弱停顿处切以尽快开口；后续块仅当强标点、或已超过软切封顶时才允许弱停顿切分
    const boundaryAllowed =
      isStrongBoundary
      || globalChunkIndex === 0
      || chunk.length >= SYNTHESIS_CHUNK_SOFT_FLUSH_CHARS;
    const meetsMinChars = chunk.length >= resolveChunkMinChars(globalChunkIndex);
    if (!boundaryAllowed || (!meetsMinChars && !reachedSentenceCap)) {
      continue;
    }

    sentences.push(chunk);
    strongBoundariesInChunk = 0;
    chunkStartIndex = index + 1;
    consumedLength = index + 1;
  }

  if (includeRemainder) {
    const remainder = text.slice(chunkStartIndex).trim();
    if (remainder) {
      sentences.push(remainder);
      consumedLength = text.length;
    }
  }

  return {
    sentences,
    consumedLength
  };
}

/** 整段文本一次切块（非流式 / 重生成路径）。 */
export function splitCompleteSentences(text: string, includeRemainder: boolean) {
  return extractReadySentences(text, includeRemainder).sentences;
}

function isSentenceDelimiter(character: string) {
  return character === "。" || character === "！" || character === "？" || character === "；" || character === "\n";
}

function isSoftSentenceDelimiter(character: string) {
  return character === "，" || character === "、" || character === ",";
}

// 开/闭括号判定：供切句阶段的括号保护使用，覆盖中文（）、英文 ()、【】、[]。
function isOpenBracket(character: string) {
  return character === "（" || character === "(" || character === "【" || character === "[";
}

function isCloseBracket(character: string) {
  return character === "）" || character === ")" || character === "】" || character === "]";
}
