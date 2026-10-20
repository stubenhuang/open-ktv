import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DEFAULT_MIX_PARAMS } from '../shared/types.ts';
import { anchorSpace } from '../shared/mix.ts';
import { createIsolatedDataDir, removeIsolatedDataDir } from './isolated.ts';

/**
 * mixJob 要写 data/works、读 data/tmp，所以同样先隔离 DATA_DIR 再动态 import
 * （静态 import 会在设环境变量前把 config.ts 求值掉）。
 * 混音本身跑真实 ffmpeg。
 */
let dataDir = '';
let workDir = '';
let db: typeof import('../server/src/db.ts');
let mixJob: typeof import('../server/src/mixJob.ts');
let helpers: typeof import('./helpers.ts');
let paths: typeof import('../server/src/paths.ts');
let pitch: typeof import('../server/src/pitch.ts');
let trackId = '';
let workId = '';

before(async () => {
  dataDir = await createIsolatedDataDir('mixjob');
  workDir = path.join(dataDir, 'fixtures');
  helpers = await import('./helpers.ts');
  fs.mkdirSync(workDir, { recursive: true });

  const accompaniment = path.join(workDir, 'accomp.mp3');
  const vocal = path.join(workDir, 'vocal.wav');
  await helpers.ffmpegOk(helpers.sineArgs(accompaniment, 3, 440, ['-c:a', 'libmp3lame', '-b:a', '192k']));
  await helpers.ffmpegOk(helpers.sineArgs(vocal, 2, 880, ['-c:a', 'pcm_s16le']));

  db = await import('../server/src/db.ts');
  mixJob = await import('../server/src/mixJob.ts');
  paths = await import('../server/src/paths.ts');
  pitch = await import('../server/src/pitch.ts');
  db.initDb();

  trackId = 'track-1';
  workId = 'work-1';
  db.insertTrack({
    id: trackId,
    title: '测试伴奏',
    artist: null,
    kind: 'audio',
    originalName: 'accomp.mp3',
    originalPath: accompaniment,
    playablePath: accompaniment,
    proxyKind: 'none',
    mime: 'audio/mpeg',
    size: 1024,
    duration: 3,
    status: 'ready',
    error: null,
  });
  db.insertWork({
    id: workId,
    trackId,
    title: '测试作品',
    vocalPath: vocal,
    vocalDuration: 2,
    autoOffsetMs: 150,
    mixParams: { ...DEFAULT_MIX_PARAMS, reverbSpace: 0 },
    status: 'mixing',
  });
});

after(async () => {
  if (dataDir) await removeIsolatedDataDir(dataDir);
});

/**
 * 一段样本在某个频率上的能量（单频 Goertzel 式的相关幅值）。
 * 用来验证「混音里到底混进了哪一档音高」：正弦伴奏移调后频率会变，
 * 数零交叉在双音叠加下不可靠，直接问某个频率更准。
 */
function toneEnergy(
  samples: Float32Array,
  sampleRate: number,
  fromSec: number,
  toSec: number,
  frequency: number,
): number {
  const from = Math.max(0, Math.round(fromSec * sampleRate));
  const to = Math.min(samples.length, Math.round(toSec * sampleRate));
  const omega = (2 * Math.PI * frequency) / sampleRate;
  let re = 0;
  let im = 0;
  for (let i = from; i < to; i += 1) {
    re += samples[i]! * Math.cos(omega * i);
    im += samples[i]! * Math.sin(omega * i);
  }
  return Math.hypot(re, im) / Math.max(1, to - from);
}

describe('mixWorkToMp3', () => {
  it('真实跑一遍 ffmpeg，产出可播放的 MP3', async () => {
    const track = db.getTrack(trackId)!;
    const work = db.getWork(workId)!;

    const result = await mixJob.mixWorkToMp3({
      work,
      track,
      onProgress: () => {},
    });

    // 路径落在（隔离的）works 目录，且和 workMp3Path 一致
    assert.equal(result.outputPath, mixJob.workMp3Path(workId));
    assert.equal(result.outputPath, path.join(paths.WORKS_DIR, `${workId}.mp3`));

    // offsetMs = userOffsetMs − autoOffsetMs（负偏移：人声提前 150ms）
    assert.equal(result.offsetMs, -150);

    // 增益是有限数（正弦波样本响度可测）
    assert.ok(Number.isFinite(result.vocalGainDb), `vocalGainDb=${result.vocalGainDb}`);
    assert.ok(Number.isFinite(result.accompGainDb), `accompGainDb=${result.accompGainDb}`);
    assert.ok(result.levels.vocalLinear > 0);
    assert.ok(result.levels.accompLinear > 0);

    const summary = await helpers.summarize(result.outputPath);
    assert.equal(summary.audioCodec, 'mp3');
    assert.equal(summary.sampleRate, 48_000);
    assert.equal(summary.channels, 2);
    assert.equal(summary.hasVideo, false);
  });

  it('forgetTrackLoudness 清掉缓存后还能再混一次', async () => {
    const track = db.getTrack(trackId)!;
    const work = db.getWork(workId)!;

    mixJob.forgetTrackLoudness(trackId);
    const result = await mixJob.mixWorkToMp3({
      work,
      track,
      onProgress: () => {},
    });
    assert.equal(result.outputPath, mixJob.workMp3Path(workId));
  });

  it('干声文件不见了：reject 且临时文件被清掉', async () => {
    const track = db.getTrack(trackId)!;
    const work = db.getWork(workId)!;

    await assert.rejects(
      mixJob.mixWorkToMp3({
        work: { ...work, vocalPath: path.join(workDir, '不存在的干声.wav') },
        track,
        onProgress: () => {},
      }),
    );

    const tmpOutput = path.join(paths.TMP_DIR, `mix-${workId}.mp3`);
    assert.equal(fs.existsSync(tmpOutput), false, '失败不该留下半截 tmp 文件');
  });

  /* ------------------------------ 修音与音效链 ------------------------------ */

  it('未开启修音时不产生预处理中间文件（老作品零回归的关键）', async () => {
    const track = db.getTrack(trackId)!;
    const work = db.getWork(workId)!;

    const result = await mixJob.mixWorkToMp3({
      work: { ...work, mixParams: { ...DEFAULT_MIX_PARAMS, reverbSpace: 0 } },
      track,
      onProgress: () => {},
    });
    assert.equal(result.outputPath, mixJob.workMp3Path(workId));

    // 中性的新参数不该多跑一次 ffmpeg，也不该在 tmp 里留东西
    const entries = await fs.promises.readdir(paths.TMP_DIR);
    assert.deepEqual(
      entries.filter((name) => name.startsWith('vocalpre-')),
      [],
      `不该有人声预处理中间文件，实际：${entries.join(', ')}`,
    );
  });

  it('开启压缩 / 均衡后仍能出片，且预处理中间文件被清掉', async () => {
    const track = db.getTrack(trackId)!;
    const work = db.getWork(workId)!;

    const result = await mixJob.mixWorkToMp3({
      work: {
        ...work,
        mixParams: {
          ...DEFAULT_MIX_PARAMS,
          reverbSpace: 0,
          compression: 0.5,
          deEss: 0.2,
          eqLowDb: 3,
          eqMidDb: -2,
          noiseReduction: true,
        },
      },
      track,
      onProgress: () => {},
    });

    const summary = await helpers.summarize(result.outputPath);
    assert.equal(summary.audioCodec, 'mp3');
    // 压缩的 makeup 并进人声线性增益，所以增益仍该是正数、有限
    assert.ok(Number.isFinite(result.levels.vocalLinear) && result.levels.vocalLinear > 0);

    // 预处理产物用临时名，跑完必须清干净（原始干声更不能被改写）
    const entries = await fs.promises.readdir(paths.TMP_DIR);
    assert.deepEqual(
      entries.filter((name) => name.startsWith('vocalpre-')),
      [],
      `预处理中间文件应被清理，实际：${entries.join(', ')}`,
    );
    assert.equal(fs.existsSync(work.vocalPath), true, '原始干声必须还在');
  });

  it('混响激活：生成 IR 临时文件喂给 afir，跑完清干净', async () => {
    const track = db.getTrack(trackId)!;
    const work = db.getWork(workId)!;

    // hall 锚点 + 90% 湿度：与真实作品的典型用法一致
    const result = await mixJob.mixWorkToMp3({
      work: {
        ...work,
        mixParams: {
          ...DEFAULT_MIX_PARAMS,
          reverbSpace: anchorSpace('hall'),
          reverbWet: 0.9,
        },
      },
      track,
      onProgress: () => {},
    });

    const summary = await helpers.summarize(result.outputPath);
    assert.equal(summary.audioCodec, 'mp3');
    assert.equal(summary.sampleRate, 48_000);
    assert.equal(summary.channels, 2);

    // IR 是中间产物：出片后不该留在 tmp 里
    const entries = await fs.promises.readdir(paths.TMP_DIR);
    assert.deepEqual(
      entries.filter((name) => name.startsWith('reverb-ir-')),
      [],
      `混响 IR 中间文件应被清理，实际：${entries.join(', ')}`,
    );
  });

  /* ------------------------------ 升降调 ------------------------------ */

  it('设了升降调：混的是移调后的那份伴奏（人声不动）', async () => {
    // 用真实 rubberband 把 440Hz 的伴奏移成 220Hz（−12 半音），
    // 再把它「登记」成这个伴奏的移调文件
    const pitched = path.join(workDir, 'accomp-down12.wav');
    await helpers.ffmpegOk(
      pitch.buildPitchShiftArgs({
        sourcePath: path.join(workDir, 'accomp.mp3'),
        outputPath: pitched,
        semitones: -12,
        kind: 'audio',
      }),
    );
    db.updateTrack(trackId, { pitchSemitones: -12, pitchPath: pitched });

    const track = db.getTrack(trackId)!;
    assert.equal(pitch.mixAccompFileFor(track), pitched, '混音要解析到移调文件');

    const work = db.getWork(workId)!;
    const result = await mixJob.mixWorkToMp3({ work, track, onProgress: () => {} });

    const decoded = await helpers.decodeToFloat32(result.outputPath);
    const energy = (hz: number) => toneEnergy(decoded.samples, decoded.sampleRate, 0.2, 1.8, hz);
    // 伴奏被移到了 220Hz；人声（干声）仍是 880Hz，一点没动
    assert.ok(
      energy(220) > energy(440) * 20,
      `成品里应主要是 220Hz 的伴奏（220=${energy(220).toExponential(2)} / 440=${energy(440).toExponential(2)}）`,
    );
    assert.ok(energy(880) > 1e-4, '干声（880Hz）必须原样混进去');

    // 收尾：回原调，别影响后面的用例
    db.updateTrack(trackId, { pitchSemitones: 0, pitchPath: null, pitchError: null });
    mixJob.forgetTrackLoudness(trackId);
  });

  it('writeReverbIr：产出的是立体声浮点 WAV，L2 复刻浏览器卷积器增益', async () => {
    const irPath = path.join(paths.TMP_DIR, 'ir-inspect.wav');
    await mixJob.writeReverbIr(anchorSpace('hall'), irPath);
    try {
      const decoded = await helpers.decodeToFloat32(irPath);
      // 48k 立体声：1.3s 尾 + 25ms 前延迟
      assert.ok(
        Math.abs(decoded.sampleRate - 48000) < 1,
        `IR 采样率应为 48000，实际 ${decoded.sampleRate}`,
      );
      const expectedLength = Math.floor(48000 * (1.3 + 0.025));
      assert.ok(
        Math.abs(decoded.samples.length - expectedLength) < 48,
        `IR 长度应约为 ${expectedLength}，实际 ${decoded.samples.length}`,
      );
      // 前 25ms 全静音
      for (let i = 0; i < Math.floor(48000 * 0.025); i += 1) {
        assert.equal(decoded.samples[i], 0, `前延迟第 ${i} 样本应为静音`);
      }
      // 尾音能量非零（下混后仍能量可测）
      const tailRms = helpers.rmsOfWindow(decoded.samples, decoded.sampleRate, 0.03, 0.5);
      assert.ok(tailRms > 1e-5, `尾音 RMS 应可测，实际 ${tailRms}`);
    } finally {
      await fs.promises.rm(irPath, { force: true });
    }
  });
});
