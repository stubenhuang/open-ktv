import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  concatFloat32,
  decodeWavBytes,
  downmixToMono,
  encodeWavBytes,
} from '../shared/wav.ts';

describe('WAV 编码', () => {
  it('写出合法的 44 字节头', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const bytes = encodeWavBytes(samples, 48_000);
    const view = new DataView(bytes.buffer);

    const ascii = (offset: number, length: number) =>
      String.fromCharCode(...Array.from({ length }, (_, i) => view.getUint8(offset + i)));

    assert.equal(ascii(0, 4), 'RIFF');
    assert.equal(ascii(8, 4), 'WAVE');
    assert.equal(ascii(12, 4), 'fmt ');
    assert.equal(ascii(36, 4), 'data');

    assert.equal(view.getUint32(4, true), 36 + samples.length * 2, 'RIFF size');
    assert.equal(view.getUint16(20, true), 1, 'PCM');
    assert.equal(view.getUint16(22, true), 1, '单声道');
    assert.equal(view.getUint32(24, true), 48_000, '采样率');
    assert.equal(view.getUint32(28, true), 96_000, 'byteRate');
    assert.equal(view.getUint16(32, true), 2, 'blockAlign');
    assert.equal(view.getUint16(34, true), 16, '位深');
    assert.equal(view.getUint32(40, true), samples.length * 2, 'data size');
    assert.equal(bytes.byteLength, 44 + samples.length * 2);
  });

  it('采样值往返不丢（精度到 1/32768）', () => {
    const samples = new Float32Array([0, 0.25, -0.25, 0.5, -0.5, 0.999]);
    const { samples: decoded, sampleRate } = decodeWavBytes(encodeWavBytes(samples, 44_100));

    assert.equal(sampleRate, 44_100);
    assert.equal(decoded.length, samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      assert.ok(
        Math.abs(decoded[i]! - samples[i]!) < 1 / 32768,
        `第 ${i} 个采样点误差过大：${decoded[i]} vs ${samples[i]}`,
      );
    }
  });

  it('超出 [-1,1] 的样本被夹住而不是溢出翻转', () => {
    const { samples } = decodeWavBytes(encodeWavBytes(new Float32Array([2, -2]), 48_000));
    assert.ok(samples[0]! > 0.99, '正向超幅仍是最大正值');
    assert.ok(samples[1]! < -0.99, '负向超幅仍是最大负值');
  });

  it('空录音也能编出合法文件', () => {
    const bytes = encodeWavBytes(new Float32Array(0), 48_000);
    assert.equal(bytes.byteLength, 44);
    assert.equal(decodeWavBytes(bytes).samples.length, 0);
  });
});

describe('PCM 分片处理', () => {
  it('concatFloat32 按顺序拼接', () => {
    const merged = concatFloat32([
      new Float32Array([1, 2]),
      new Float32Array([3]),
      new Float32Array([4, 5]),
    ]);
    assert.deepEqual(Array.from(merged), [1, 2, 3, 4, 5]);
  });

  it('downmixToMono 对多声道取平均、长度取最短', () => {
    const mono = downmixToMono([
      new Float32Array([1, 0]),
      new Float32Array([0, 1]),
      new Float32Array([1, 1]),
    ]);
    assert.equal(mono.length, 2);
    // Float32 精度，用近似比较
    assert.ok(Math.abs(mono[0]! - 2 / 3) < 1e-6);
    assert.ok(Math.abs(mono[1]! - 2 / 3) < 1e-6);
  });

  it('downmixToMono 单声道原样返回', () => {
    const single = new Float32Array([0.1, 0.2]);
    assert.equal(downmixToMono([single]), single);
  });
});
