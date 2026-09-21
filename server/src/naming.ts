/**
 * multipart 请求头里的 filename 默认按 latin1 解码（busboy 的历史行为），
 * 中文文件名会变成「æ´å¤©」这种乱码。这里还原成 UTF-8。
 *
 * 判定逻辑：
 *   全部码点 ≤ 0x7F  → 纯 ASCII，本来就没问题
 *   全部码点 ≤ 0xFF  → 只可能是被按 latin1 误读的字节，转回 UTF-8
 *   出现码点 > 0xFF  → 说明已经是正确解码的文本，原样保留
 */
export function decodeOriginalName(rawName: string): string {
  if (!rawName) return rawName;

  let maxCodePoint = 0;
  for (const char of rawName) {
    const codePoint = char.codePointAt(0)!;
    if (codePoint > maxCodePoint) maxCodePoint = codePoint;
  }

  if (maxCodePoint <= 0x7f) return rawName;
  if (maxCodePoint > 0xff) return rawName;

  const restored = Buffer.from(rawName, 'latin1').toString('utf8');
  // 还原结果里出现替换字符，说明原始字节并不是合法 UTF-8，保持原样更安全
  return restored.includes('\uFFFD') ? rawName : restored;
}

/**
 * 从上传的文件名里猜歌名和歌手：
 *   "周杰伦 - 晴天.mp3"      → { artist: "周杰伦", title: "晴天" }
 *   "晴天.flac"              → { artist: null, title: "晴天" }
 *   "03 夜曲.mp4"            → { artist: null, title: "03 夜曲" }
 */
export function parseNameParts(originalName: string): { title: string; artist: string | null } {
  const withoutExtension = originalName.replace(/\.[^./\\]+$/, '');
  const cleaned = withoutExtension.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();

  if (!cleaned) return { title: '未命名伴奏', artist: null };

  // 优先按「两侧都有空格」的分隔符切：歌手名里本来就可能有连字符
  // （A-Lin、Jay-Z、王力宏-…），不加空格要求会把 A-Lin 切成 A / Lin
  const spaced = cleaned.match(/^(.{1,40}?)\s+[-–—]\s+(.+)$/);
  const matched = spaced ?? cleaned.match(/^(.{1,40}?)\s*[-–—]\s*(.+)$/);

  if (matched) {
    const artist = matched[1]!.trim();
    const title = matched[2]!.trim();
    if (artist && title) return { artist, title };
  }

  return { title: cleaned, artist: null };
}

/** 保留原始扩展名用于 Content-Type 判定；拿不到就用兜底扩展名 */
export function safeExtension(originalName: string, fallback: string): string {
  const dotIndex = originalName.lastIndexOf('.');
  // dotIndex <= 0 覆盖两种情况：根本没有扩展名，以及文件名叫 ".mp3" 这种
  if (dotIndex <= 0) return fallback;

  const extension = originalName
    .slice(dotIndex)
    .toLowerCase()
    .replace(/[^.a-z0-9]/g, '');

  if (extension.length <= 1 || extension.length > 8) return fallback;
  return extension;
}
