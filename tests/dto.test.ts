import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mixKey, trackToDto, trackToListItem, transcodeKey, workToDto, workToListItem } from '../server/src/dto.ts';
import type { TrackRecord, WorkRecord } from '../server/src/db.ts';
import { enqueue } from '../server/src/jobs.ts';
import type { MixParams, ProxyKind, TrackKind, TrackStatus, WorkStatus } from '../shared/types.ts';

function makeTrack(overrides: Partial<TrackRecord> = {}): TrackRecord {
  return {
    id: 't1',
    title: '晴天',
    artist: '周杰伦',
    kind: 'audio' as TrackKind,
    originalName: '周杰伦 - 晴天.mp3',
    originalPath: '/data/originals/t1.mp3',
    playablePath: '/data/originals/t1.mp3',
    proxyKind: 'none' as ProxyKind,
    mime: 'audio/mpeg',
    size: 1024,
    duration: 215.5,
    status: 'ready' as TrackStatus,
    error: null,
    createdAt: 1000,
    ...overrides,
  };
}

function makeWork(overrides: Partial<WorkRecord> = {}): WorkRecord {
  const mixParams: MixParams = { vocalGain: 1, accompGain: 1, reverb: 'room', userOffsetMs: 0 };
  return {
    id: 'w1',
    trackId: 't1',
    title: '晴天（我的演唱 06-01 12:00）',
    vocalPath: '/data/vocals/w1.wav',
    vocalDuration: 180.25,
    autoOffsetMs: 150,
    mixParams,
    levels: null,
    mp3Path: null,
    status: 'mixing' as WorkStatus,
    error: null,
    createdAt: 2000,
    updatedAt: 3000,
    ...overrides,
  };
}

describe('trackToDto / trackToListItem', () => {
  it('不泄露磁盘路径', () => {
    const dto = trackToDto(makeTrack());
    assert.equal('originalPath' in dto, false);
    assert.equal('playablePath' in dto, false);
    assert.equal(dto.title, '晴天');
    assert.equal(dto.artist, '周杰伦');
    assert.equal(dto.size, 1024);
    assert.equal(dto.duration, 215.5);
  });

  it('非 processing 状态 progress 为 null', () => {
    assert.equal(trackToListItem(makeTrack({ status: 'ready' })).progress, null);
    assert.equal(trackToListItem(makeTrack({ status: 'failed' })).progress, null);
  });

  it('processing 但没有排队任务时 progress 兜底 0', () => {
    assert.equal(trackToListItem(makeTrack({ status: 'processing' })).progress, 0);
  });

  it('processing 时 progress 来自任务队列', async () => {
    await new Promise<void>((resolve) => {
      enqueue(transcodeKey('t1'), async (report) => {
        report(0.42);
        resolve();
      }, () => resolve());
    });

    assert.equal(trackToListItem(makeTrack({ status: 'processing' })).progress, 0.42);
  });
});

describe('workToDto / workToListItem', () => {
  it('全字段映射，levels 允许为 null（老作品）', () => {
    const dto = workToDto(makeWork());
    assert.equal(dto.id, 'w1');
    assert.equal(dto.trackId, 't1');
    assert.equal(dto.vocalDuration, 180.25);
    assert.equal(dto.autoOffsetMs, 150);
    assert.deepEqual(dto.mixParams, { vocalGain: 1, accompGain: 1, reverb: 'room', userOffsetMs: 0 });
    assert.equal(dto.levels, null);
    assert.equal(dto.status, 'mixing');
    assert.equal(dto.createdAt, 2000);
    assert.equal(dto.updatedAt, 3000);
    // 磁盘路径不下发
    assert.equal('vocalPath' in dto, false);
    assert.equal('mp3Path' in dto, false);
  });

  it('levels 有值时透传', () => {
    const levels = { vocalGainDb: -3.5, accompGainDb: 1.25 };
    assert.deepEqual(workToDto(makeWork({ levels })).levels, levels);
  });

  it('listItem 带上伴奏信息，伴奏没了给 null', () => {
    const withTrack = workToListItem(makeWork(), makeTrack());
    assert.equal(withTrack.trackTitle, '晴天');
    assert.equal(withTrack.trackKind, 'audio');

    const orphan = workToListItem(makeWork());
    assert.equal(orphan.trackTitle, null);
    assert.equal(orphan.trackKind, null);
  });
});

describe('队列 key', () => {
  it('前缀固定，前端和服务端靠它对上', () => {
    assert.equal(transcodeKey('abc'), 'transcode:abc');
    assert.equal(mixKey('abc'), 'mix:abc');
  });
});
