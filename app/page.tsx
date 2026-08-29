import { StartSessionButton } from "@/components/home/start-session-button";

export default function Home() {
  return (
    <main className="min-h-screen bg-stone-100 px-5 py-10 text-stone-900">
      <section className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-md flex-col justify-center gap-6 rounded-3xl bg-white p-7 shadow-sm ring-1 ring-stone-200">
        <div className="space-y-3">
          <p className="text-sm font-medium tracking-wide text-amber-700">
            白酒创意调饮 · 本地学习原型
          </p>
          <h1 className="text-3xl leading-tight font-semibold">黔调</h1>
          <p className="leading-7 text-stone-600">
            每次开始都会创建属于你自己的调饮会话：口味偏好、桌面材料识别、三套配方推荐与调配，一步步完成。
          </p>
        </div>
        <StartSessionButton />
      </section>
    </main>
  );
}
