/**
 * 文本分块
 *
 * 规则：
 * - 优先按段落（双换行）切分
 * - 单段过长时按固定长度切分（默认 256 字符），保留 overlap 32 字符
 * - 过滤过短块（< 10 字符）
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

export function chunkText(raw: string, opts: ChunkOptions = {}): Chunk[] {
  const maxLength = opts.maxLength ?? 256;
  const overlap = opts.overlap ?? 32;
  const minLength = opts.minLength ?? 10;

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
    // 切分为滑动窗口
    let start = 0;
    while (start < para.length) {
      const end = Math.min(start + maxLength, para.length);
      const slice = para.slice(start, end);
      if (slice.length >= minLength) {
        out.push({ text: slice, index: globalIdx++ });
      }
      if (end === para.length) break;
      start = end - overlap;
    }
  }
  return out;
}
