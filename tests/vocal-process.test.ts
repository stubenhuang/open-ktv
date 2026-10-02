import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildVocalPreProcessArgs } from '../server/src/mix.ts';
import { cleanupDir, ffmpegOk, makeTempDir, sineArgs } from './helpers.ts';

/**
 * 人声预处理 pass。
 *
 * 纯参数构造用断言查（滤镜该不该挂、顺序对不对）；效果靠实跑 ffmpeg 数峰值验证 ——
 * 只看参数串证明不了「压缩真的把峰值压下来了」。
 */

let workDir = '';

before(async () => {
  workDir = await makeTempDir('vocal-process');
});

after(async () => {
  if (workDir) await cleanupDir(workDir);
});

const NEUTRAL = {
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

/** 16bit PCM 的峰值振幅 */
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
    // 仍然统一格式，混音图拿到的东西规格一致
    assert.match(chain, /aformat=sample_rates=48000:channel_layouts=stereo/);
  });

  it('降噪 → 压缩 → 去齿音，顺序固定', () => {
    const chain = filterChain(
      vocalArgs({ noiseReduction: true, compression: 0.5, deEss: 0.4 }),
    );

    const positions = ['afftdn', 'acompressor', 'deesser'].map((filter) => {
      const index = chain.indexOf(filter);
      assert.ok(index >= 0, `缺少 ${filter}：${chain}`);
      return index;
    });

    // 降噪必须在动态处理之前，否则压缩器会被底噪触发
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

  it('输出统一成 48k 立体声 16bit PCM（便于混音图直接吃）', () => {
    const args = vocalArgs({ compression: 0.3 });
    assert.ok(args.includes('-ar') && args.includes('48000'));
    assert.equal(args[args.indexOf('-ac') + 1], '2');
    assert.equal(args[args.indexOf('-c:a') + 1], 'pcm_s16le');
  });
});

describe('预处理真实出片（真实 ffmpeg）', () => {
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

  it('降噪 + 压缩 + 去齿音组合也能跑通（有声音出、不是静音）', async () => {
    const pcm = await runAndMeasure('combo', {
      noiseReduction: true,
      compression: 0.4,
      deEss: 0.3,
    });
    assert.ok(peakAmplitude(pcm) > 0, '组合处理后不该整段静音');
  });
});
