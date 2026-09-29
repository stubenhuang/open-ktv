/**
 * 把录音过程中攒下来的 Float32 PCM 编码成 16bit 单声道 WAV。
 *
 * 为什么不用 MediaRecorder 出 webm/opus：opus 编码器有固有的前导延迟，
 * 而我们要靠「采样点」跟伴奏对齐，WAV 是无损且采样点精确的。
 *
 * 采集链路本身必然是单声道（AudioWorkletNode 用 channelCount: 1 显式下混，
 * pcm-capture 也只取 inputs[0][0]），所以这里没有多声道下混的分支。
 */

/** 拼接多个分片（AudioWorklet 是一块一块吐出来的） */
export function concatFloat32(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;

  const output = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

/** 44 字节标准头 + PCM 数据 */
export function encodeWavBytes(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');

  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk 长度
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byteRate
  view.setUint16(32, bytesPerSample, true); // blockAlign
  view.setUint16(34, 16, true); // 位深

  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    // 夹到 [-1, 1]，避免爆音时整数溢出翻转
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    // 用 32768 缩放（解码时同样除以 32768），量化误差对称且不超过半个 LSB
    const scaled = Math.max(-32768, Math.min(32767, Math.round(clamped * 32768)));
    view.setInt16(offset, scaled, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

export function encodeWavBlob(samples: Float32Array, sampleRate: number): Blob {
  return new Blob([encodeWavBytes(samples, sampleRate)], { type: 'audio/wav' });
}
