import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
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
    mixParams: { vocalGain: 1, accompGain: 1, reverb: 'dry', userOffsetMs: 0 },
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

    // offsetMs = autoOffsetMs + userOffsetMs
    assert.equal(result.offsetMs, 150);

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
});
