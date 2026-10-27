/**
 * 在途检索结果接收守卫（纯函数，便于单测）
 *
 * 检索是异步的；请求返回时模型、集合或请求代次可能已经变化。
 * 只有三者都仍匹配当前状态时，才允许把结果写回 UI store。
 */
export interface SearchGuardContext {
  requestId: number;
  currentRequestId: number;
  modelKey: string;
  currentModel: string;
  collectionName: string | null;
  currentCollectionName: string | null;
}

export function shouldAcceptSearchResult(ctx: SearchGuardContext): boolean {
  return (
    ctx.requestId === ctx.currentRequestId &&
    ctx.modelKey === ctx.currentModel &&
    ctx.collectionName === ctx.currentCollectionName
  );
}
