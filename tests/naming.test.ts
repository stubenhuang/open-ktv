import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeOriginalName, parseNameParts, safeExtension } from '../server/src/naming.ts';

describe('multipart 文件名解码', () => {
  it('还原被按 latin1 误读的中文文件名', () => {
    // 模拟 busboy 的行为：UTF-8 字节被当成 latin1 字符
    const mojibake = Buffer.from('周杰伦 - 晴天.mp3', 'utf8').toString('latin1');
    assert.notEqual(mojibake, '周杰伦 - 晴天.mp3');
    assert.equal(decodeOriginalName(mojibake), '周杰伦 - 晴天.mp3');
  });

  it('纯 ASCII 文件名原样返回', () => {
    assert.equal(decodeOriginalName('track-01.mp3'), 'track-01.mp3');
  });

  it('已经是正确 Unicode 的文件名不被二次解码', () => {
    assert.equal(decodeOriginalName('周杰伦 - 晴天.mp3'), '周杰伦 - 晴天.mp3');
  });

  it('原始字节不是合法 UTF-8 时不乱改', () => {
    // 0xFF 0xFE 不是合法 UTF-8 序列
    const weird = String.fromCharCode(0xff, 0xfe);
    assert.equal(decodeOriginalName(weird), weird);
  });

  it('空名字不崩', () => {
    assert.equal(decodeOriginalName(''), '');
  });
});

describe('从文件名猜歌名/歌手', () => {
  it('识别「歌手 - 歌名」', () => {
    assert.deepEqual(parseNameParts('周杰伦 - 晴天.mp3'), { artist: '周杰伦', title: '晴天' });
    assert.deepEqual(parseNameParts('A-Lin – 给我一个理由忘记.flac'), {
      artist: 'A-Lin',
      title: '给我一个理由忘记',
    });
  });

  it('没有分隔符时整个当歌名', () => {
    assert.deepEqual(parseNameParts('晴天.mp3'), { artist: null, title: '晴天' });
    assert.deepEqual(parseNameParts('03 夜曲.mp4'), { artist: null, title: '03 夜曲' });
  });

  it('下划线换成空格', () => {
    assert.deepEqual(parseNameParts('陈奕迅_富士山下.wav'), { artist: null, title: '陈奕迅 富士山下' });
  });

  it('空名字给个兜底', () => {
    assert.deepEqual(parseNameParts('.mp3'), { artist: null, title: '未命名伴奏' });
  });
});

describe('扩展名白名单', () => {
  it('保留正常扩展名', () => {
    assert.equal(safeExtension('a.MP3', '.mp3'), '.mp3');
    assert.equal(safeExtension('a.mkv', '.mp4'), '.mkv');
  });

  it('构造出的扩展名永远不含路径字符', () => {
    const evil = safeExtension('a.mp3/../../etc/passwd', '.mp3');
    assert.doesNotMatch(evil, /[/\\]/);
  });

  it('没有扩展名或扩展名过长时用兜底', () => {
    assert.equal(safeExtension('noext', '.mp3'), '.mp3');
    assert.equal(safeExtension('a.verylongextension', '.mp4'), '.mp4');
  });
});
