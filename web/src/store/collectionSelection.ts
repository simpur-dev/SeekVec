/**
 * 集合选择（纯函数，便于单测）
 *
 * 约定：
 * - 每个文本模型有约定命名的集合：text_zh → kb_text_zh，text_en → kb_text_en
 * - useCollections 回填集合清单后，优先保留用户当前选择；失效时回退约定集合
 * - useSearch 只读 activeCollection；失效时回退约定命名并给出提示（不再按名字盲猜其他集合）
 */
import type { CollectionSummary, ModelKey } from '../types';
import { getModelInfo, defaultCollectionName } from '../inference/models';
import { useKbStore } from './kbStore';

export { defaultCollectionName as expectedCollectionName };

/** 集合是否可用于当前文本模型（模态 + 模型 + 维度均匹配） */
export function isCollectionCompatible(
  collection: CollectionSummary | undefined,
  modelKey: ModelKey,
): boolean {
  if (!collection) return false;
  if (collection.modality !== 'text') return false;
  if (collection.modelKey !== modelKey) return false;
  return collection.dimension === getModelInfo(modelKey).dim;
}

/**
 * 决定启动时/模型切换后的 activeCollection：
 * 1) 当前选择仍可用 → 保留
 * 2) 约定集合存在且可用 → 回退约定集合
 * 3) 否则 null（由用户在集合下拉中显式选择）
 */
export function pickActiveCollection(
  collections: Record<string, CollectionSummary>,
  active: string | null,
  modelKey: ModelKey,
): string | null {
  if (active && isCollectionCompatible(collections[active], modelKey)) return active;
  const expected = defaultCollectionName(modelKey);
  if (isCollectionCompatible(collections[expected], modelKey)) return expected;
  return null;
}

export interface SearchCollectionResolution {
  /** 实际用于检索的集合（null=不可用） */
  collection: CollectionSummary | null;
  /** 期望/回退的集合名（用于错误提示与占位） */
  name: string;
  /** 非空时 UI 必须提示（集合失效 / 已回退约定命名） */
  notice: string | null;
}

/**
 * 检索时的集合解析：
 * - activeCollection 可用 → 直接用
 * - 失效（不存在/维度不符/模型不符）→ 回退约定命名并提示
 * - 约定集合也不可用 → 返回提示文案
 */
export function resolveSearchCollection(
  collections: Record<string, CollectionSummary>,
  active: string | null,
  modelKey: ModelKey,
): SearchCollectionResolution {
  const expected = defaultCollectionName(modelKey);
  const expectedCollection = collections[expected];
  const activeCollection = active ? collections[active] : undefined;

  if (active && isCollectionCompatible(activeCollection, modelKey)) {
    return { collection: activeCollection!, name: active, notice: null };
  }

  if (isCollectionCompatible(expectedCollection, modelKey)) {
    let notice: string | null = null;
    if (active && activeCollection) {
      notice = `当前集合 ${active} 与模型 ${
        modelKey === 'text_zh' ? '中文' : '英文'
      }（${getModelInfo(modelKey).dim}d）不匹配，已回退到约定集合 ${expected}`;
    } else if (active) {
      notice = `当前集合 ${active} 不存在（可能已被删除），已回退到约定集合 ${expected}`;
    }
    return { collection: expectedCollection!, name: expected, notice };
  }

  const dim = getModelInfo(modelKey).dim;
  if (active && activeCollection) {
    return {
      collection: null,
      name: active,
      notice: `当前集合 ${active} 不可用（需要 ${dim}d 文本集合，实际 ${activeCollection.dimension}d/${activeCollection.modality}），请重新选择集合或导入文档`,
    };
  }
  if (active) {
    return {
      collection: null,
      name: active,
      notice: `当前集合 ${active} 不存在（可能已被删除），请重新选择集合或导入文档`,
    };
  }
  return {
    collection: null,
    name: expected,
    notice: `未找到文本集合 ${expected}，请先在「导入文本」中导入文档`,
  };
}

/** 只读当前 activeCollection（组件外调用） */
export function getActiveCollection(): string | null {
  return useKbStore.getState().activeCollection;
}
