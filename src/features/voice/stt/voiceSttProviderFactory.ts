import { DoubaoStreamingSttProvider } from "./doubaoStreamingSttProvider";
import { LocalStreamingSttProvider } from "./localStreamingSttProvider";
import type { VoiceSttProvider, VoiceSttProviderMode } from "./voiceSttContract";

/**
 * STT provider 唯一工厂。
 * local 失败只如实报错，不自动回落到 managed；managed 只在用户显式选择时使用。
 */
export function createVoiceSttProvider(mode: VoiceSttProviderMode): VoiceSttProvider {
  return mode === "managed"
    ? new DoubaoStreamingSttProvider()
    : new LocalStreamingSttProvider();
}
