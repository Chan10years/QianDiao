export default function Home() {
  return (
    <main className="min-h-screen bg-stone-100 px-5 py-10 text-stone-900">
      <section className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-md flex-col justify-center gap-6 rounded-3xl bg-white p-7 shadow-sm ring-1 ring-stone-200">
        <div className="space-y-3">
          <p className="text-sm font-medium tracking-wide text-amber-700">本地学习原型</p>
          <h1 className="text-3xl leading-tight font-semibold">白酒创意调饮 Agent</h1>
          <p className="leading-7 text-stone-600">
            工具链已初始化。后续流程会从口味偏好开始，逐步完成识别、配方、安全检查与反馈调整。
          </p>
        </div>
        <div className="rounded-2xl bg-stone-50 p-4 text-sm text-stone-600" role="status">
          当前状态：基础服务可用，主流程尚未启用。
        </div>
      </section>
    </main>
  );
}
