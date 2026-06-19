export type VoidVisualState = "idle" | "listening" | "thinking" | "speaking";

export type BlobVisualProfile = {
  baseColor: string;
  edgeColor: string;
  bloomIntensity: number;
  scale: number;
  noiseSpeed: number;
  edgeBoost: number;
  amplitude: number;
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

export const BLOB_VISUAL_PROFILES: Record<VoidVisualState, BlobVisualProfile> = {
  idle: {
    baseColor: "#0A0AFF",
    edgeColor: "#00CFFF",
    bloomIntensity: 2.05,
    scale: 0.9,
    noiseSpeed: 0.21,
    edgeBoost: 1.08,
    amplitude: 0.28,
    capsuleMode: "closed"
  },
  listening: {
    baseColor: "#0A0AFF",
    edgeColor: "#00CFFF",
    bloomIntensity: 2.42,
    scale: 0.94,
    noiseSpeed: 0.29,
    edgeBoost: 1.32,
    amplitude: 0.31,
    capsuleMode: "open"
  },
  thinking: {
    baseColor: "#2200FF",
    edgeColor: "#00CFFF",
    bloomIntensity: 1.85,
    scale: 0.82,
    noiseSpeed: 0.18,
    edgeBoost: 0.98,
    amplitude: 0.24,
    capsuleMode: "focused"
  },
  speaking: {
    baseColor: "#0A0AFF",
    edgeColor: "#00CFFF",
    bloomIntensity: 2.68,
    scale: 0.94,
    noiseSpeed: 0.31,
    edgeBoost: 1.52,
    amplitude: 0.32,
    capsuleMode: "open"
  }
};
