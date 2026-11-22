/**
 * 语音引擎注册表（可插拔：用户下拉选 TTS / ASR 引擎）。
 * 每家引擎提供 synth（文字转语音 PCM 流）/ transcribe（语音转文字）/ voices / sampleRate。
 * 内置 DeepSeek 引擎包装现有 speech.ts；第三方引擎可按同结构扩展。
 * 纯 TS 注册表 + 工厂，与 UI 解耦。
 */

export type VoiceOption = { id: string; name: string }

export type SpeechProvider = {
  id: string
  name: string
  /** 合成 PCM 采样率（AudioContext 用） */
  sampleRate: number
  voices: VoiceOption[]
  synth: (
    key: string,
    text: string,
    voice: string,
    signal: AbortSignal
  ) => Promise<ReadableStream<Uint8Array>>
  transcribe: (key: string, audio: Blob, signal?: AbortSignal) => Promise<string>
}

/** DeepSeek 引擎：包装现有 speech.ts 调用 */
const deepseekProvider: SpeechProvider = {
  id: 'deepseek',
  name: 'DeepSeek',
  sampleRate: 24000,
  voices: [
    { id: 'stella', name: 'Stella' },
    { id: 'tide', name: 'Tide' },
  ],
  synth: async (key, text, voice, signal) => {
    const { synthesize } = await import('./api/speech.js')
    return synthesize(key, text, voice as 'stella' | 'tide', signal)
  },
  transcribe: async (key, audio, signal) => {
    const { transcribe } = await import('./api/speech.js')
    return transcribe(key, audio, signal)
  },
}

export const SPEECH_PROVIDERS: SpeechProvider[] = [deepseekProvider]
export const SPEECH_PROVIDER_IDS = SPEECH_PROVIDERS.map((p) => p.id)

export const getSpeechProvider = (id: string): SpeechProvider =>
  SPEECH_PROVIDERS.find((p) => p.id === id) ?? deepseekProvider
