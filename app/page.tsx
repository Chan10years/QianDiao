import { StartSessionButton } from "@/components/home/start-session-button";

export default function Home() {
  return (
    <main className="home-page">
      <div className="home-page__content">
        <header className="home-page__top">
          <p className="home-page__brand">黔调</p>
          <p className="home-page__code">AI MIX / FIELD TEST</p>
        </header>

        <section className="home-page__hero" aria-labelledby="home-title">
          <p className="home-page__eyebrow">贵州白酒 · 个性化调饮实验</p>
          <h1 id="home-title" className="home-page__title">
            <span className="home-page__title-primary">黔调</span>
            <br />
            <span className="home-page__title-secondary">中调</span>
            <br />
            <span className="home-page__title-secondary">你的调</span>
          </h1>
          <p className="home-page__tagline">你口袋里的贵州白酒AI调酒师</p>
          <p className="home-page__description">
            告诉我你喜欢的口感，再拍下手边的酒和饮料。我会先确认，再为你找一杯真正做得到的。
          </p>

          <div className="home-page__flavor-mark" role="img" aria-label="贵州风土调饮意象">
            <p>山有层 · 酒有香 · 人有偏好</p>
            <span aria-hidden="true">黔</span>
          </div>

          <StartSessionButton />
        </section>

        <footer className="home-page__footer">
          <div className="home-page__landscape" aria-hidden="true" />
          <p>未成年人和患相关疾病者禁止饮酒。</p>
        </footer>
      </div>
    </main>
  );
}
