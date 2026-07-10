/**
 * 豆包双向流式 TTS 桥接的「浏览器 ↔ 桥接」JSON 信封协议。
 *
 * 与 STT 同构（见 stt/voiceSttBridgeProtocol.ts）：浏览器无法给原生 WebSocket 设自定义鉴权头，
 * 故由服务端桥接（server/voiceTtsBridge.ts）在 Node 侧注入 X-Api-* 头、并完成豆包二进制帧编解码。
 * 浏览器只与桥接交换这套 JSON 信封。
 *
 * 数据流：
 *   浏览器 --(start/text/finish JSON)--> 桥接 --(二进制帧+鉴权头)--> 豆包
 *   豆包 --(AudioOnlyServer 音频帧)--> 桥接 --(ready/audio/done/error JSON)--> 浏览器
 */

/** 送入 StartSession 的音频参数（豆包 audio_params 子集，整数增量语义见 doubaoTtsProvider.toDoubaoRate） */
export type DoubaoBidirectionalAudioParams = {
  format: string;
  sampleRate: number;
  // 语速/音量整数增量 [-50,100]，0=正常；仅本轮情绪派生出对应值时才带。
  speechRate?: number;
  loudnessRate?: number;
};

/** 浏览器 → 桥接 的客户端事件 */
export type DoubaoBidirectionalClientEvent =
  | {
      type: "start";
      appId: string;
      accessKey: string;
      resourceId: string;
      speaker: string;
      audioParams: DoubaoBidirectionalAudioParams;
    }
  | {
      type: "text";
      text: string;
    }
  | {
      type: "finish";
    };

/** 桥接 → 浏览器 的服务端事件 */
export type DoubaoBidirectionalServerEvent =
  | {
      // 握手完成（ConnectionStarted + SessionStarted 均已就绪），可以开始发文本
      type: "ready";
    }
  | {
      // 一块音频数据（AudioOnlyServer 帧的 payload），base64 编码
      type: "audio";
      audioBase64: string;
    }
  | {
      // 整段合成结束（SessionFinished / TTSEnded），浏览器据此收尾拼装
      type: "done";
    }
  | {
      type: "error";
      message: string;
    };

/** 运行时判定桥接下行事件（浏览器侧收帧用） */
export function isDoubaoBidirectionalServerEvent(
  payload: unknown
): payload is DoubaoBidirectionalServerEvent {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }

  const event = payload as Record<string, unknown>;
  return typeof event.type === "string";
}
