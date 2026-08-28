/**
 * セカンドオピニオン（Issue #894 / #926）へ送るプロンプトの組み立て。
 *
 * この機能は「独立したレビュアー」ではなく、進行中の作業に対する**独立したAdvisor**である。
 * 求められるのはコードレビューに限らず、設計判断の妥当性・A/B/Cの選択・進めてよいかの判断・
 * 次に検証すべきことも含む。
 *
 * **独立性とは、作業を担当しているAIのセッション状態・内部コンテキストを継承しないこと**であり、
 * コンテキストをゼロにすることではない（Issue #926 P0）。渡すのは「利用者の依頼文」「別セッションが
 * 記録から作った背景要約」「今回評価してほしい追加資料」の3つで、親セッションの会話そのものは渡さない。
 *
 * `vscode` にも CLI にも依存しない純粋な文字列組み立て。ここを単体テストで固定し、
 * 「親セッションの会話が混ざらない」（受入基準4）を検証する。
 */

/** 起動時点で固定した、作業ツリーの変更。 */
export interface WorkspaceSnapshot {
  /** `git rev-parse HEAD` の結果。 */
  baseCommit: string;
  /** `git diff <baseCommit>` の結果。 */
  diff: string;
  /** 上限を超えて末尾を落としたか。 */
  truncated: boolean;
}

/**
 * 今回の依頼に添える追加資料。
 *
 * 基本コンテキストは背景要約であり、ここは「今回とくに見てほしいもの」を指す。
 * `none` でも、依頼文と背景要約だけで相談は成立する（差分の無い設計相談が主経路になりうる）。
 *
 * `lastAssistantResponse` は「いまのAIの回答そのものを見てほしい」ときのための明示的なopt-in。
 * 既定にはしない（親セッションの出力＝そのエージェントのフレーミングをそのまま渡すことになり、
 * 独立性が下がるため）。
 */
export type SecondOpinionArtifact =
  | { kind: 'workspaceChanges'; snapshot: WorkspaceSnapshot }
  | { kind: 'lastAssistantResponse'; response: string }
  | { kind: 'none' };

/** `SecondOpinionArtifact['kind']` の一覧（設定値・UIの選択肢の検証に使う）。 */
export const SECOND_OPINION_ARTIFACT_KINDS = [
  'workspaceChanges',
  'lastAssistantResponse',
  'none',
] as const;

export type SecondOpinionArtifactKind = (typeof SECOND_OPINION_ARTIFACT_KINDS)[number];

/** 選択UIに出す表示名。 */
export const ARTIFACT_KIND_LABELS: Record<SecondOpinionArtifactKind, string> = {
  workspaceChanges: '作業ツリーの変更（起動時点のスナップショット）',
  lastAssistantResponse: '直近のエージェント応答',
  none: '追加資料なし（依頼文と背景だけで相談する）',
};

/**
 * セカンドオピニオンへ渡す材料一式（Issue #926 P0）。
 *
 * 並びが意味を持つ。`userRequest` が今回の問い、`conversationSummary` がその背景、
 * `artifact` は「今回とくに見てほしい追加資料」である。差分を主役に据えた旧構造
 * （`SecondOpinionContext`）はコードレビューには合っていたが、相談用途には合わなかった。
 */
export interface SecondOpinionInput {
  /** 利用者が編集した、今回聞きたいこと。 */
  userRequest: string;
  /**
   * 別セッションが会話の記録から作った背景要約（Issue #903）。基本コンテキスト。
   * 設定で切っている・作れなかった場合は渡さない。
   *
   * 会話が短く要約セッションを開かなかった場合（Issue #944）は、会話の記録そのものが
   * ここへ入る。どちらなのかは {@link conversationBackgroundKind} で示す。
   */
  conversationSummary?: string | undefined;
  /**
   * {@link conversationSummary} が要約か、会話の記録そのものかの区別（Issue #944）。
   * 省略時は `'summary'`（従来どおり）。
   *
   * 見出しと注意書きを出し分けるために要る。要約でないものを「別のセッションが作った要約」
   * として見せると、圧縮による抜けを警戒させる必要のない材料を疑わせることになり、
   * 逆に記録を要約と偽ることにもなる。
   */
  conversationBackgroundKind?: ConversationBackgroundKind | undefined;
  /** 今回評価してほしい追加資料。 */
  artifact: SecondOpinionArtifact;
}

/** 背景として渡した本文の出所（Issue #944）。 */
export type ConversationBackgroundKind = 'summary' | 'transcript';

/** 既定の依頼文。設定 `agent.secondOpinion.template` の既定値でもある。 */
export const DEFAULT_SECOND_OPINION_TEMPLATE =
  'この変更をレビューしてください。特に設計上の欠陥、見落とし、より単純な代替案を挙げてください。';

/**
 * 本文をコードフェンスで囲む。
 *
 * diffや応答本文の中にバッククォート3連が現れるとフェンスが途中で閉じ、以降が
 * 地の文として読まれてしまう。本文中の最長のバッククォート連続より1つ長い
 * フェンスを使うことで、中身が何であっても囲みが壊れないようにする
 * （CommonMarkのfenced code blockの規則）。
 */
function fence(body: string, info: string): string {
  let longest = 0;
  for (const run of body.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length);
  }
  const marker = '`'.repeat(Math.max(3, longest + 1));
  return `${marker}${info}\n${body}\n${marker}`;
}

/**
 * 独立したAdvisorであることと、材料の読み方を伝える固定指示。
 *
 * 「現在のworking treeを見るな」は文面だけの約束ではなく、実際にスナップショットを
 * 押下時にcaptureして渡すことで裏打ちする（`snapshot.ts`）。文面はそのうえで、
 * 実行中に人が触ったファイルを読みに行かせないための補強として置く。
 *
 * 最後の1文（回答は自動反映されない）は、Advisorに「利用者へ判断材料を出す」書き方を
 * させるためのもの。作業指示として書かせると、そのまま実行される前提の文体になる。
 */
function systemInstruction(
  artifact: SecondOpinionArtifact,
  hasSummary: boolean,
  backgroundKind: ConversationBackgroundKind,
): string {
  const lines = [
    'あなたは、別のAIエージェントが進めている作業について、独立した立場から意見を求められています。',
    '求められるのはコードレビューに限りません。設計判断の妥当性、複数案からの選択、このまま進めてよいかの判断、次に検証すべきことなども対象です。依頼文の求めに合わせて答えてください。',
    'そのエージェントとの会話そのものや、そのエージェントの内部の判断過程は渡されていません。以下の材料だけを根拠に、あなた自身で判断してください。',
    '分からない前提を推測で埋めないでください。不明な点は「不明」として指摘してください。',
    'ファイルの書き換えは行わないでください（読み取りのみが許可されています）。',
    'あなたの回答は利用者へ表示されるだけで、元の作業へ自動では反映されません。採否は利用者が判断します。',
  ];
  if (hasSummary) {
    // 要約を作ったのは作業したエージェント自身ではない（`summary.ts`）。それでも圧縮である
    // 以上は落ちた情報があり、要約に引きずられて追加資料を読まない事故を避ける必要がある。
    // 会話が短く要約を作らなかった場合（Issue #944）は圧縮ではないため、その旨を書かない
    lines.push(
      backgroundKind === 'summary'
        ? '「ここまでの背景」は、会話を見ていない別のセッションが記録から作った圧縮であり、抜けや誤りがありえます。'
        : '「ここまでの背景」は、その会話の記録そのものです（短いため要約していません）。',
    );
    if (artifact.kind !== 'none') {
      lines.push(
        '背景と追加資料が食い違う場合は追加資料を優先し、食い違い自体を指摘してください。',
      );
    }
  }
  // 調査の範囲（Issue #944）。read-onlyのツールは使えるため、指示が無いと材料で足りる問いでも
  // リポジトリを読み回り、そのぶん回答が遅れる。何を根拠にすべきかは資料の種類で決まる
  if (artifact.kind === 'workspaceChanges') {
    lines.push(
      '以下の baseCommit と差分を、現在の変更の正本として扱ってください。',
      '現在の作業ツリーは実行中に変更されている可能性があるため、判断の根拠に含めないでください。',
      'ベース側のコードを読む必要がある場合は `git show <baseCommit>:<path>` を使ってください。',
      'ただし読むのは判断に必要な範囲に限り、リポジトリ全体の探索は行わないでください。',
    );
  } else {
    lines.push(
      '渡された材料だけで答えてください。リポジトリを探索する必要はありません。',
      '材料だけでは答えられない場合は、探しに行くのではなく、何が足りないかを書いてください。',
    );
  }
  return lines.join('\n');
}

function artifactSection(artifact: SecondOpinionArtifact): string | undefined {
  switch (artifact.kind) {
    case 'workspaceChanges': {
      const { baseCommit, diff, truncated } = artifact.snapshot;
      const notice = truncated
        ? '\n\n注意: 差分が大きいため末尾を省略しています。省略部分については判断を保留し、その旨を明記してください。'
        : '';
      return (
        `## 追加資料: 作業ツリーの変更（起動時点のスナップショット）\n\nbaseCommit: ${baseCommit}\n\n` +
        `${fence(diff, 'diff')}${notice}`
      );
    }
    case 'lastAssistantResponse':
      return `## 追加資料: 直近のエージェント応答\n\n${fence(artifact.response, '')}`;
    case 'none':
      return undefined;
  }
}

/**
 * 背景要約の区画（Issue #903）。
 *
 * 誰が作った要約なのかを本文へ明記する。作業した本人の要約とは重みが違い、Advisor側が
 * それを知らないと「エージェント自身の言い分」として読んでしまうため。
 */
function summarySection(summary: string, kind: ConversationBackgroundKind): string {
  const heading =
    kind === 'summary'
      ? '## ここまでの背景（作業したエージェント自身ではなく、別のセッションが記録から作った要約）'
      : '## ここまでの背景（会話の記録そのもの。短いため要約していません）';
  return `${heading}\n\n${fence(summary, '')}`;
}

/**
 * 送信するプロンプト全文を組み立てる。
 *
 * 並びは「固定指示 → 依頼 → ここまでの背景 → 追加資料」。依頼文・背景・追加資料を明確に
 * 分けた見出しの下に置くことで、資料の中に指示めいた文字列が含まれていても、それが資料の
 * 一部であることが読み取れるようにする。
 *
 * `conversationSummary` を渡さなければ背景の区画自体が出ない（設定で要約を切ったときに、
 * 元の会話に由来する材料が一切渡らないことの担保。Issue #903 受入基準6）。
 */
export function buildSecondOpinionPrompt(input: SecondOpinionInput): string {
  const summary = input.conversationSummary?.trim() ?? '';
  const backgroundKind = input.conversationBackgroundKind ?? 'summary';
  const sections = [
    systemInstruction(input.artifact, summary !== '', backgroundKind),
    `## 依頼\n\n${input.userRequest.trim()}`,
    summary === '' ? undefined : summarySection(summary, backgroundKind),
    artifactSection(input.artifact),
  ].filter((section): section is string => section !== undefined);
  return sections.join('\n\n');
}
