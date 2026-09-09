/**
 * 图片管线面板（v1.1 待启用）
 *
 * 架构已就绪：Schema factory + MODEL_REGISTRY + 双集合 search。
 * v1.1 将启用 CLIP 模型加载与图片预处理 pipeline。
 */
export function IngestImagePanel() {
  return (
    <section className="rounded-xl border border-dashed border-slate-200 bg-white p-6 text-center shadow-sm">
      <h2 className="text-sm font-semibold text-slate-800">图片管线 · v1.1 待启用</h2>
      <p className="mx-auto mt-3 max-w-xl text-xs leading-relaxed text-slate-600">
        图片集合 <code className="mx-1 rounded bg-slate-100 px-1.5 py-0.5">kb_image</code> 已在 Schema 工厂、MODEL_REGISTRY
        与双集合检索接口中预留。v1.1 将启用 CLIP 视觉塔，端侧向量化后写入图片集合。
      </p>
      <ul className="mx-auto mt-4 max-w-xl space-y-1.5 text-left text-xs text-slate-600">
        <li className="flex items-start gap-2">
          <span className="mt-0.5 text-emerald-500">✓</span>
          <span>Schema 工厂已支持 modality='image'</span>
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-0.5 text-emerald-500">✓</span>
          <span>MODEL_REGISTRY 已注册 CLIP（512d）</span>
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-0.5 text-emerald-500">✓</span>
          <span>POST /api/images 路由已实现</span>
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-0.5 text-emerald-500">✓</span>
          <span>loadModelWithFallback 已支持 image 模型懒加载与 WASM 降级</span>
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-0.5 text-slate-400">○</span>
          <span className="text-slate-400">图片预处理与缩略图预览（v1.1 启用）</span>
        </li>
      </ul>
    </section>
  );
}
