// Qwen3-TTS CustomVoice 的内置音色白名单。
// 只列官方模型卡声明的 9 个 speaker；不要在前端私造 speaker id。

export const DEFAULT_QWEN3_SPEAKER = "ono_anna";

export type Qwen3Speaker = {
  id: string;
  label: string;
  zh: string;
  en: string;
};

export const QWEN3_SPEAKERS: readonly Qwen3Speaker[] = [
  { id: "ono_anna", label: "Ono Anna", zh: "日语女声，活泼轻快", en: "Japanese female, lively" },
  { id: "vivian", label: "Vivian", zh: "中文女声，明亮年轻", en: "Chinese female, bright and young" },
  { id: "serena", label: "Serena", zh: "中文女声，温柔", en: "Chinese female, warm" },
  { id: "uncle_fu", label: "Uncle Fu", zh: "中文男声，低沉成熟", en: "Chinese male, low and mature" },
  { id: "dylan", label: "Dylan", zh: "中文男声，北京口音", en: "Chinese male, Beijing accent" },
  { id: "eric", label: "Eric", zh: "中文男声，成都口音", en: "Chinese male, Sichuan accent" },
  { id: "ryan", label: "Ryan", zh: "英文男声，节奏感强", en: "English male, rhythmic" },
  { id: "aiden", label: "Aiden", zh: "英文男声，阳光", en: "English male, sunny" },
  { id: "sohee", label: "Sohee", zh: "韩语女声，温暖", en: "Korean female, warm" }
];

export function normalizeQwen3Speaker(value: string | undefined | null): string {
  const trimmed = value?.trim() ?? "";
  return QWEN3_SPEAKERS.some((speaker) => speaker.id === trimmed)
    ? trimmed
    : DEFAULT_QWEN3_SPEAKER;
}

export function findQwen3Speaker(id: string): Qwen3Speaker {
  return QWEN3_SPEAKERS.find((speaker) => speaker.id === id) ?? QWEN3_SPEAKERS[0];
}
