/**
 * セカンドオピニオン（Issue #894）へ送るプロンプトの組み立て。
 *
 * **親セッションの会話は一切入れない。** この機能の値打ちは「いまのエージェントが
 * 持っている仮説・見落とし・フレーミングを引き継がずに評価させる」ことにあり、
 * 会話の要約すら渡さない（要約した時点で、いまのエージェントの解釈が混ざる）。
 * 渡すのは「起動時点の成果物」と「利用者が書いた依頼文」だけ。
 *
 * `vscode` にも CLI にも依存しない純粋な文字列組み立て。ここを単体テストで固定し、
 * 「親セッションの会話が混ざらない」（受入基準4）を検証する。
 */

/** 起動時点で固定した、レビュー対象の成果物。 */
export interface WorkspaceSnapshot {
  /** `git rev-parse HEAD` の結果。 */
  baseCommit: string;
  /** `git diff HEAD` の結果。 */
  diff: string;
  /** 上限を超えて末尾を落としたか。 */
  truncated: boolean;
}

/**
 * レビュー対象として何を渡すか。
 *
 * `lastAssistantResponse` は「いまのAIの回答そのものを見てほしい」ときのための
 * 明示的なopt-in。既定にはしない（親セッションの出力＝そのエージェントのフレーミングを
 * そのまま渡すことになり、独立性が下がるため）。
 */
export type SecondOpinionContext =
  | { kind: 'workspaceSnapshot'; snapshot: WorkspaceSnapshot }
  | { kind: 'lastAssistantResponse'; response: string }
  | { kind: 'none' };

/** `SecondOpinionContext['kind']` の一覧（設定値・UIの選択肢の検証に使う）。 */
export const SECOND_OPINION_CONTEXT_KINDS = [
  'workspaceSnapshot',
  'lastAssistantResponse',
  'none',
] as const;

export type SecondOpinionContextKind = (typeof SECOND_OPINION_CONTEXT_KINDS)[number];

/** 選択UIに出す表示名。 */
export const CONTEXT_KIND_LABELS: Record<SecondOpinionContextKind, string> = {
  workspaceSnapshot: '作業ツリーの変更（起動時点のスナップショット）',
  lastAssistantResponse: '直近のエージェント応答のみ',
  none: '依頼文のみ',
};

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
 * 独立レビューであることと、レビュー対象の正本がどれかを伝える固定指示。
 *
 * 「現在のworking treeを見るな」は文面だけの約束ではなく、実際にスナップショットを
 * 押下時にcaptureして渡すことで裏打ちする（`snapshot.ts`）。文面はそのうえで、
 * 実行中に人が触ったファイルを読みに行かせないための補強として置く。
 */
function systemInstruction(context: SecondOpinionContext): string {
  const lines = [
    'あなたは、別のAIエージェントが進めている作業に対する独立したレビュアーです。',
    'そのエージェントとの会話内容は渡されていません。以下の情報だけを根拠に評価してください。',
    '分からない前提を推測で埋めないでください。不明な点は「不明」として指摘してください。',
    'ファイルの書き換えは行わないでください（読み取りのみが許可されています）。',
  ];
  if (context.kind === 'workspaceSnapshot') {
    lines.push(
      '以下の baseCommit と差分を、レビュー対象の正本として扱ってください。',
      '現在の作業ツリーはレビュー中に変更されている可能性があるため、レビュー対象に含めないでください。',
      'ベース側のコードを読む必要がある場合は `git show <baseCommit>:<path>` を使ってください。',
    );
  }
  return lines.join('\n');
}

function contextSection(context: SecondOpinionContext): string | undefined {
  switch (context.kind) {
    case 'workspaceSnapshot': {
      const { baseCommit, diff, truncated } = context.snapshot;
      const notice = truncated
        ? '\n\n注意: 差分が大きいため末尾を省略しています。省略部分については判断を保留し、その旨を明記してください。'
        : '';
      return (
        `## レビュー対象（起動時点のスナップショット）\n\nbaseCommit: ${baseCommit}\n\n` +
        `${fence(diff, 'diff')}${notice}`
      );
    }
    case 'lastAssistantResponse':
      return `## レビュー対象（直近のエージェント応答）\n\n${fence(context.response, '')}`;
    case 'none':
      return undefined;
  }
}

/**
 * 送信するプロンプト全文を組み立てる。
 *
 * 並びは「固定指示 → 利用者の依頼 → レビュー対象」。依頼文とレビュー対象を明確に
 * 分けた見出しの下に置くことで、対象の中に指示めいた文字列が含まれていても、それが
 * レビュー対象の一部であることが読み取れるようにする。
 */
export function buildSecondOpinionPrompt(input: {
  request: string;
  context: SecondOpinionContext;
}): string {
  const sections = [
    systemInstruction(input.context),
    `## 依頼\n\n${input.request.trim()}`,
    contextSection(input.context),
  ].filter((section): section is string => section !== undefined);
  return sections.join('\n\n');
}
