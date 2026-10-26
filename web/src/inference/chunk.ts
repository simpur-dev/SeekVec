/**
 * 文本分块
 *
 * 规则：
 * - 优先按段落（双换行）切分
 * - 单段过长时按固定长度切分（默认 256 字符），保留 overlap 32 字符
 * - 过滤过短块（< 10 字符）
 *
 * 安全约束：overlap 始终 < maxLength（否则窗口不前进会死循环）；
 * 切分点避开 UTF-16 代理对（避免把 emoji 等切成乱码）。
 */

export interface ChunkOptions {
  maxLength?: number;
  overlap?: number;
  minLength?: number;
}

export interface Chunk {
  text: string;
  index: number;
}

/** 若切点落在代理对中间，则回退一位 */
function safeEndIndex(text: string, start: number, end: number): number {
  if (end >= text.length || end <= start + 1) return end;
  const prev = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  const prevIsHighSurrogate = prev >= 0xd800 && prev <= 0xdbff;
  const nextIsLowSurrogate = next >= 0xdc00 && next <= 0xdfff;
  return prevIsHighSurrogate && nextIsLowSurrogate ? end - 1 : end;
}

export function chunkText(raw: string, opts: ChunkOptions = {}): Chunk[] {
  const maxLength = Math.max(1, opts.maxLength ?? 256);
  const overlap = Math.min(Math.max(0, opts.overlap ?? 32), maxLength - 1);
  const minLength = Math.max(0, opts.minLength ?? 10);

  const paragraphs = raw
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length >= minLength);

  const out: Chunk[] = [];
  let globalIdx = 0;
  for (const para of paragraphs) {
    if (para.length <= maxLength) {
      out.push({ text: para, index: globalIdx++ });
      continue;
    }
    // 切分为滑动窗口（overlap < maxLength，保证每次前进）
    let start = 0;
    while (start < para.length) {
      const end = safeEndIndex(para, start, Math.min(start + maxLength, para.length));
      const slice = para.slice(start, end);
      if (slice.length >= minLength) {
        out.push({ text: slice, index: globalIdx++ });
      }
      if (end >= para.length) break;
      start = end - overlap;
    }
  }
  return out;
}
