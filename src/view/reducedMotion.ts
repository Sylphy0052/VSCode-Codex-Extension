/**
 * 動きを減らす設定（`prefers-reduced-motion`）への追随（issue #760）。
 *
 * webviewはElectronのレンダラなので、OS側の「視差効果を減らす」がそのまま届く。
 *
 * アニメーションを1つずつ名指しで止める形にすると、後から足したものが漏れる。漏れた側は
 * 誰も気付かないまま動き続けるため、全称セレクタで一括して抑える。止めるのではなく
 * 極短時間で終わらせるのは、`animationend` / `transitionend` を待つ処理があっても
 * 止まらないようにするため（このリポジトリに現時点でその依存は無いが、後から足せる）。
 *
 * VS Code組み込みのアイコンアニメーション（履歴ツリーの `sync~spin` など）はwebviewの
 * 外なので、ここでは止められない。
 */
export function reducedMotionStyles(): string {
  return `
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
      scroll-behavior: auto !important;
    }
  }
`;
}
