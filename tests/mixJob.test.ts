import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DEFAULT_MIX_PARAMS, type MixParams } from '../shared/types.ts';
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
  db.initDb();
  // 生产里 index.ts 启动时会探测 ffmpeg 能力；测试直接调 mixJob，得自己探一次，
  // 否则 getFfmpegCapabilities() 会保守地返回「不支持 rubberband」，升降调被清零
  await (await import('../server/src/ffmpegCapabilities.ts')).detectFfmpegCapabilities();

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
    mixParams: { ...DEFAULT_MIX_PARAMS, reverb: 'dry' },
    status: 'mixing',
  });
});

after(async () => {
  if (dataDir) await removeIsolatedDataDir(dataDir);
});

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
      work: { ...work, mixParams: { ...DEFAULT_MIX_PARAMS, reverb: 'dry' } },
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
    assert.deepEqual(entries.filter((name) => name.startsWith('pitch-')), []);
  });

  it('开启压缩 / 均衡后仍能出片，且预处理中间文件被清掉', async () => {
    const track = db.getTrack(trackId)!;
    const work = db.getWork(workId)!;

    const result = await mixJob.mixWorkToMp3({
      work: {
        ...work,
        mixParams: {
          ...DEFAULT_MIX_PARAMS,
          reverb: 'dry',
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

  it('伴奏升降调：第一次跑生成缓存，第二次直接复用', async () => {
    const track = db.getTrack(trackId)!;
    const work = db.getWork(workId)!;
    const params: MixParams = { ...DEFAULT_MIX_PARAMS, reverb: 'dry', accompSemitones: 2 };

    const first = await mixJob.mixWorkToMp3({
      work: { ...work, mixParams: params },
      track,
      onProgress: () => {},
    });
    assert.equal((await helpers.summarize(first.outputPath)).audioCodec, 'mp3');

    // 变调结果按 (trackId, 半音数) 缓存在 tmp 里，供后续「合成」复用
    const cached = (await fs.promises.readdir(paths.TMP_DIR)).filter((name) =>
      name.startsWith(`pitch-${trackId}-`),
    );
    assert.equal(cached.length, 1, `应缓存一份变调结果，实际：${cached.join(', ')}`);
    assert.match(cached[0]!, /-p2\.wav$/);

    // 第二次：缓存命中，不需要重新变调（这里只验证仍能出片且缓存没多出一份）
    const second = await mixJob.mixWorkToMp3({
      work: { ...work, mixParams: params },
      track,
      onProgress: () => {},
    });
    assert.equal((await helpers.summarize(second.outputPath)).audioCodec, 'mp3');
    const again = (await fs.promises.readdir(paths.TMP_DIR)).filter((name) =>
      name.startsWith(`pitch-${trackId}-`),
    );
    assert.equal(again.length, 1, '缓存命中不该再生成一份');

    // 删除伴奏时缓存要被清掉
    mixJob.forgetTrackPreProcess(trackId);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const afterCleanup = (await fs.promises.readdir(paths.TMP_DIR)).filter((name) =>
      name.startsWith(`pitch-${trackId}-`),
    );
    assert.deepEqual(afterCleanup, []);
  });
});
