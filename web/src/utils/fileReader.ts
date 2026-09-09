/**
 * 文件读取工具：支持 .txt / .md 纯文本
 */

export async function readTextFile(file: File): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (!['txt', 'md', 'markdown'].includes(ext ?? '')) {
    throw new Error(`暂不支持文件类型：.${ext}（v1 仅 .txt / .md）`);
  }
  return await file.text();
}

export function isTextLike(file: File): boolean {
  const ext = file.name.split('.').pop()?.toLowerCase();
  return ['txt', 'md', 'markdown'].includes(ext ?? '');
}

export function isImageLike(file: File): boolean {
  return file.type.startsWith('image/');
}
