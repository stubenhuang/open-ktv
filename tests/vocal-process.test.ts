import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  buildAccompPreProcessArgs,
  buildVocalPreProcessArgs,
} from '../server/src/mix.ts';
import { cleanupDir, ffmpegOk, makeTempDir, sineArgs } from './helpers.ts';

/**
 * 人声/伴奏预处理 pass。
 *
 * 纯参数构造用断言查（滤镜该不该挂、顺序对不对）；音高是否真的变了
 * 就实跑 ffmpeg，把输出导成原始 PCM 数零交叉来验证 —— 这比 grep 参数串
 * 能真正证明「升降调生效」，也能抓出 rubberband 参数写错方向这类问题。
 */

let workDir = '';

before(async () => {
  workDir = await makeTempDir('vocal-process');
});

after(async () => {
  if (workDir) await cleanupDir(workDir);
});

const NEUTRAL = {
  pitchSemitones: 0,
  compression: 0,
  deEss: 0,
  noiseReduction: false,
};

function vocalArgs(overrides: Partial<Parameters<typeof buildVocalPreProcessArgs>[0]> = {}) {
  return buildVocalPreProcessArgs({
    sourcePath: '/tmp/in.wav',
    outputPath: '/tmp/out.wav',
    ...NEUTRAL,
    ...overrides,
  });
}

/** 取出 -af 后面的滤镜串 */
function filterChain(args: string[]): string {
  const index = args.indexOf('-af');
  assert.ok(index >= 0, '参数里应该有 -af');
  return args[index + 1]!;
}

/**
 * 数零交叉估基频：对纯正弦足够准（一个周期过零两次）。
 * 只取中间 50% 的样本，避开首尾可能的淡入淡出。
 */
function estimateFrequencyHz(buffer: Buffer, sampleRate = 48_000): number {
  const samples = Math.floor(buffer.length / 2);
  const start = Math.floor(samples * 0.25);
  const end = Math.floor(samples * 0.75);

  let crossings = 0;
  let previous = buffer.readInt16LE(start * 2);
  for (let index = start + 1; index < end; index += 1) {
    const current = buffer.readInt16LE(index * 2);
    if ((previous < 0 && current >= 0) || (previous >= 0 && current < 0)) crossings += 1;
    previous = current;
  }

  const seconds = (end - start) / sampleRate;
  return crossings / 2 / seconds;
}

function peakAmplitude(buffer: Buffer): number {
  let peak = 0;
  for (let index = 0; index + 1 < buffer.length; index += 2) {
    peak = Math.max(peak, Math.abs(buffer.readInt16LE(index)));
  }
  return peak;
}

/** 跑一遍预处理，再把结果导成原始 PCM 方便测量 */
async function runAndMeasure(
  name: string,
  options: Partial<Parameters<typeof buildVocalPreProcessArgs>[0]>,
): Promise<Buffer> {
  const source = path.join(workDir, `${name}-in.wav`);
  const processed = path.join(workDir, `${name}-out.wav`);
  const raw = path.join(workDir, `${name}-out.raw`);

  await ffmpegOk(sineArgs(source, 2, 440, ['-c:a', 'pcm_s16le']));
  await ffmpegOk(
    vocalArgs({ sourcePath: source, outputPath: processed, ...options }).slice(
      // ffmpegOk 自己会加 -y -hide_banner -loglevel error；去掉重复的 -y
      1,
    ),
  );
  await ffmpegOk(['-i', processed, '-f', 's16le', '-ac', '1', '-ar', '48000', raw]);
  return fs.readFileSync(raw);
}

describe('buildVocalPreProcessArgs：只挂该挂的滤镜', () => {
  it('全中性时不挂任何处理滤镜（老作品走的就是这条）', () => {
    const chain = filterChain(vocalArgs());
    assert.doesNotMatch(chain, /afftdn/);
    assert.doesNotMatch(chain, /acompressor/);
    assert.doesNotMatch(chain, /deesser/);
    assert.doesNotMatch(chain, /rubberband/);
    // 仍然统一格式，混音图拿到的东西规格一致
    assert.match(chain, /aformat=sample_rates=48000:channel_layouts=stereo/);
  });

  it('降噪 → 压缩 → 去齿音 → 升降调，顺序固定', () => {
    const chain = filterChain(
      vocalArgs({ noiseReduction: true, compression: 0.5, deEss: 0.4, pitchSemitones: 3 }),
    );

    const positions = ['afftdn', 'acompressor', 'deesser', 'rubberband'].map((filter) => {
      const index = chain.indexOf(filter);
      assert.ok(index >= 0, `缺少 ${filter}：${chain}`);
      return index;
    });

    // 降噪必须在动态处理之前，否则压缩器会被底噪触发；
    // 升降调放最后，避免让前面的处理工作在变调后的音色上
    assert.deepEqual(
      positions.slice().sort((a, b) => a - b),
      positions,
      `滤镜顺序不对：${chain}`,
    );
  });

  it('压缩量映射到 acompressor 的阈值与压缩比，且不自己带 makeup', () => {
    const chain = filterChain(vocalArgs({ compression: 1 }));
    assert.match(chain, /acompressor=threshold=-24\.00dB/);
    assert.match(chain, /ratio=6\.00/);
    // makeup 并进了人声线性增益（vocalChainLinearGain），滤镜里不许再做一次
    assert.doesNotMatch(chain, /makeup/);
  });

  it('升降调用频率比而不是半音数；±12 是八度', () => {
    assert.match(filterChain(vocalArgs({ pitchSemitones: 12 })), /rubberband=pitch=2\.000000:tempo=1/);
    assert.match(filterChain(vocalArgs({ pitchSemitones: -12 })), /rubberband=pitch=0\.500000:tempo=1/);
    // 变速必须关掉：tempo=1 才是「只变调不变速」
    assert.match(filterChain(vocalArgs({ pitchSemitones: 5 })), /tempo=1/);
  });

  it('小数半音取整；0.4 半音等于不动', () => {
    assert.doesNotMatch(filterChain(vocalArgs({ pitchSemitones: 0.4 })), /rubberband/);
    assert.match(filterChain(vocalArgs({ pitchSemitones: 2.6 })), /rubberband=pitch=1\.189207/);
  });

  it('输出统一成 48k 立体声 16bit PCM（便于混音图直接吃）', () => {
    const args = vocalArgs({ compression: 0.3 });
    assert.ok(args.includes('-ar') && args.includes('48000'));
    assert.equal(args[args.indexOf('-ac') + 1], '2');
    assert.equal(args[args.indexOf('-c:a') + 1], 'pcm_s16le');
  });

  it('伴奏预处理只做升降调，不碰人声链', () => {
    const chain = filterChain(
      buildAccompPreProcessArgs({
        sourcePath: '/tmp/a.mp3',
        outputPath: '/tmp/a.wav',
        accompSemitones: -3,
      }),
    );
    assert.match(chain, /rubberband=pitch=0\.840896:tempo=1/);
    assert.doesNotMatch(chain, /acompressor|deesser|afftdn/);
  });
});

describe('预处理真实出片（真实 ffmpeg）', () => {
  it('不处理时基频保持 440Hz（对照组）', async () => {
    const pcm = await runAndMeasure('plain', {});
    const frequency = estimateFrequencyHz(pcm);
    assert.ok(Math.abs(frequency - 440) < 15, `应接近 440Hz，实际 ${frequency.toFixed(1)}Hz`);
  });

  it('+12 半音把 440Hz 抬到约 880Hz（且不改变时长）', async () => {
    const pcm = await runAndMeasure('up-octave', { pitchSemitones: 12 });
    const frequency = estimateFrequencyHz(pcm);
    assert.ok(
      Math.abs(frequency - 880) < 30,
      `+12 半音应该正好一个八度（约 880Hz），实际 ${frequency.toFixed(1)}Hz`,
    );
  });

  it('−12 半音把 440Hz 降到约 220Hz', async () => {
    const pcm = await runAndMeasure('down-octave', { pitchSemitones: -12 });
    const frequency = estimateFrequencyHz(pcm);
    assert.ok(
      Math.abs(frequency - 220) < 12,
      `−12 半音应该低一个八度（约 220Hz），实际 ${frequency.toFixed(1)}Hz`,
    );
  });

  it('压缩确实把峰值压下来了（makeup 不在这里做）', async () => {
    const source = path.join(workDir, 'loud-in.wav');
    const processed = path.join(workDir, 'loud-out.wav');
    const rawIn = path.join(workDir, 'loud-in.raw');
    const rawOut = path.join(workDir, 'loud-out.raw');

    // ffmpeg 的 sine 源振幅只有 1/8，先推上去造一个「很响」的输入
    await ffmpegOk(sineArgs(source, 2, 440, ['-af', 'volume=18dB', '-c:a', 'pcm_s16le']));
    await ffmpegOk(
      vocalArgs({ sourcePath: source, outputPath: processed, compression: 1 }).slice(1),
    );

    await ffmpegOk(['-i', source, '-f', 's16le', '-ac', '1', '-ar', '48000', rawIn]);
    await ffmpegOk(['-i', processed, '-f', 's16le', '-ac', '1', '-ar', '48000', rawOut]);

    const before = peakAmplitude(fs.readFileSync(rawIn));
    const after = peakAmplitude(fs.readFileSync(rawOut));
    assert.ok(after < before, `压缩后峰值应下降：${before} → ${after}`);
  });

  it('降噪 + 去齿音 + 升降调组合也能跑通', async () => {
    const pcm = await runAndMeasure('combo', {
      noiseReduction: true,
      compression: 0.4,
      deEss: 0.3,
      pitchSemitones: -5,
    });
    const frequency = estimateFrequencyHz(pcm);
    // −5 半音 ≈ 440 × 2^(−5/12) ≈ 329.6Hz
    assert.ok(
      Math.abs(frequency - 329.6) < 15,
      `−5 半音后应约 329.6Hz，实际 ${frequency.toFixed(1)}Hz`,
    );
  });
});
