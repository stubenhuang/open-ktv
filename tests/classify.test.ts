import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyProbe, type FfprobeResult, type FfprobeStream } from '../server/src/classify.ts';

function audioStream(codec: string): FfprobeStream {
  return { index: 0, codec_type: 'audio', codec_name: codec };
}

function videoStream(codec: string, extra: Partial<FfprobeStream> = {}): FfprobeStream {
  return { index: 0, codec_type: 'video', codec_name: codec, width: 1920, height: 1080, ...extra };
}

function probe(formatName: string, streams: FfprobeStream[], duration = '215.5'): FfprobeResult {
  return { format: { format_name: formatName, duration }, streams };
}

describe('classifyProbe', () => {
  it('mp3 直接可播', () => {
    const result = classifyProbe(probe('mp3', [audioStream('mp3')]), { extension: '.mp3' });
    assert.equal(result.kind, 'audio');
    assert.equal(result.playable, true);
    assert.equal(result.proxyKind, 'none');
    assert.equal(result.durationSec, 215.5);
  });

  it('wav/flac/ogg 直接可播', () => {
    assert.equal(classifyProbe(probe('wav', [audioStream('pcm_s16le')]), { extension: '.wav' }).playable, true);
    assert.equal(classifyProbe(probe('flac', [audioStream('flac')]), { extension: '.flac' }).playable, true);
    assert.equal(classifyProbe(probe('ogg', [audioStream('opus')]), { extension: '.ogg' }).playable, true);
  });

  it('m4a/aac 直接可播', () => {
    const result = classifyProbe(probe('mov,mp4,m4a,3gp,3g2,mj2', [audioStream('aac')]), {
      extension: '.m4a',
    });
    assert.equal(result.kind, 'audio');
    assert.equal(result.playable, true);
  });

  it('ape / wma 这类需要转码成 mp3', () => {
    const ape = classifyProbe(probe('ape', [audioStream('ape')]), { extension: '.ape' });
    assert.equal(ape.kind, 'audio');
    assert.equal(ape.playable, false);
    assert.equal(ape.proxyKind, 'audio');

    const wma = classifyProbe(probe('asf', [audioStream('wmav2')]), { extension: '.wma' });
    assert.equal(wma.playable, false);
    assert.equal(wma.proxyKind, 'audio');
  });

  it('mp4/h264+aac 视频直接可播', () => {
    const result = classifyProbe(
      probe('mov,mp4,m4a,3gp,3g2,mj2', [videoStream('h264'), audioStream('aac')]),
      { extension: '.mp4' },
    );
    assert.equal(result.kind, 'video');
    assert.equal(result.playable, true);
    assert.equal(result.proxyKind, 'none');
  });

  it('mp4 里塞 h265 要转码', () => {
    const result = classifyProbe(
      probe('mov,mp4,m4a,3gp,3g2,mj2', [videoStream('hevc'), audioStream('aac')]),
      { extension: '.mp4' },
    );
    assert.equal(result.kind, 'video');
    assert.equal(result.playable, false);
    assert.equal(result.proxyKind, 'video');
  });

  it('mkv（哪怕编码看起来是 webm 兼容的）也必须转码', () => {
    const result = classifyProbe(
      probe('matroska,webm', [videoStream('vp9'), audioStream('opus')]),
      { extension: '.mkv' },
    );
    assert.equal(result.kind, 'video');
    assert.equal(result.playable, false, 'ffprobe 把 mkv 也报成 matroska,webm，必须靠扩展名兜底');
    assert.equal(result.proxyKind, 'video');
  });

  it('真正的 .webm 可以直接播', () => {
    const result = classifyProbe(
      probe('matroska,webm', [videoStream('vp9'), audioStream('opus')]),
      { extension: '.webm' },
    );
    assert.equal(result.playable, true);
  });

  it('avi/flv/mov-h265 一律转码', () => {
    assert.equal(
      classifyProbe(probe('avi', [videoStream('mpeg4'), audioStream('mp3')]), { extension: '.avi' })
        .playable,
      false,
    );
    assert.equal(
      classifyProbe(probe('flv', [videoStream('flv1'), audioStream('aac')]), { extension: '.flv' })
        .playable,
      false,
    );
  });

  it('封面图（attached_pic）不算视频流', () => {
    const result = classifyProbe(
      probe('mp3', [
        { index: 0, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
        { index: 1, codec_type: 'audio', codec_name: 'mp3' },
      ]),
      { extension: '.mp3' },
    );
    assert.equal(result.kind, 'audio');
    assert.equal(result.playable, true);
  });

  it('没有音频流时给出可读原因', () => {
    const result = classifyProbe(probe('mp4', [videoStream('h264')]), { extension: '.mp4' });
    assert.equal(result.kind, 'video');
    assert.match(result.reason, /mp4/);
  });

  it('完全没有流（损坏文件）不崩', () => {
    const result = classifyProbe({ format: { format_name: 'mp3' }, streams: [] }, { extension: '.mp3' });
    assert.equal(result.playable, false);
    assert.match(result.reason, /找不到音频流/);
  });

  it('时长缺失时回退到流上的 duration', () => {
    const result = classifyProbe({
      format: { format_name: 'matroska,webm' },
      streams: [
        { codec_type: 'video', codec_name: 'h264', duration: '91.25' },
        { codec_type: 'audio', codec_name: 'aac', duration: '90.00' },
      ],
    });
    assert.equal(result.durationSec, 91.25);
  });
});
