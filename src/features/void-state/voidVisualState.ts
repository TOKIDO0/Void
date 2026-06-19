export type VoidVisualState = "idle" | "listening" | "thinking" | "speaking";

export type BlobColorSchemeName =
  | "voidBlue"
  | "userVoiceOrange"
  | "thinkingLavender";

export type BlobColorScheme = {
  baseColor: string;
  edgeColor: string;
};

export type BlobVisualProfile = {
  colorScheme: BlobColorSchemeName;
  bloomIntensity: number;
  scale: number;
  shapeScale: [number, number, number];
  noiseSpeed: number;
  edgeBoost: number;
  amplitude: number;
  irregularity: number;
  innerFlow: number;
  capsuleMode: "closed" | "open" | "focused";
};

export const VOID_VISUAL_STATE_ORDER: VoidVisualState[] = [
  "idle",
  "listening",
  "thinking",
  "speaking"
];

export const VOID_VISUAL_STATE_BY_KEY: Record<string, VoidVisualState> = {
  "1": "idle",
  "2": "listening",
  "3": "thinking",
  "4": "speaking"
};

export const BLOB_COLOR_SCHEMES: Record<BlobColorSchemeName, BlobColorScheme> = {
  voidBlue: {
    baseColor: "#0A0AFF",
    edgeColor: "#00CFFF"
  },
  userVoiceOrange: {
    baseColor: "#FFAE6A",
    edgeColor: "#FFD5A8"
  },
  thinkingLavender: {
    baseColor: "#A78BFF",
    edgeColor: "#E0C7FF"
  }
};

export const BLOB_VISUAL_PROFILES: Record<VoidVisualState, BlobVisualProfile> = {
  idle: {
    colorScheme: "voidBlue",
    bloomIntensity: 2.05,
    scale: 0.9,
    shapeScale: [1, 1, 1],
    noiseSpeed: 0.21,
    edgeBoost: 1.08,
    amplitude: 0.28,
    irregularity: 1,
    innerFlow: 1,
    capsuleMode: "closed"
  },
  listening: {
    colorScheme: "userVoiceOrange",
    bloomIntensity: 2.42,
    scale: 0.9,
    shapeScale: [1.012, 0.996, 1.008],
    noiseSpeed: 0.33,
    edgeBoost: 1.32,
    amplitude: 0.34,
    irregularity: 1.22,
    innerFlow: 1.18,
    capsuleMode: "open"
  },
  thinking: {
    colorScheme: "thinkingLavender",
    bloomIntensity: 1.85,
    scale: 0.9,
    shapeScale: [0.985, 1.028, 0.99],
    noiseSpeed: 0.16,
    edgeBoost: 0.98,
    amplitude: 0.24,
    irregularity: 0.86,
    innerFlow: 1.32,
    capsuleMode: "focused"
  },
  speaking: {
    colorScheme: "voidBlue",
    bloomIntensity: 2.68,
    scale: 0.9,
    shapeScale: [1, 1, 1],
    noiseSpeed: 0.31,
    edgeBoost: 1.52,
    amplitude: 0.32,
    irregularity: 1.08,
    innerFlow: 1.16,
    capsuleMode: "open"
  }
};
