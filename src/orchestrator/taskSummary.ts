import { lastNonEmptyAgentMessageText, type ChatState } from '../appserver/chatState';
import { stripControlChars } from './sanitize';

/**
 * ワークフローViewのノード・一覧に出す「直近の応答の1行要約」を組み立てる（design.md §16.8）。
 *
 * `runner.ts` がタスクの `ChatState` が変わるたびに呼び、結果は `LiveTask` に持たせて
 * Viewのスナップショットへ渡す。**応答本文そのものは永続化しない**（design.md §16.11）ため、
 * ここで作るのはあくまでメモリ上・表示専用の短い要約であり、`workspaceState` へは書かない。
 *
 * VSCode APIには依存しない純粋関数。`ChatState` は `appserver` 層の型だが、値を読むだけで
 * 副作用を持たないためテストしやすい。
 */

/** 表示用に切り詰める上限文字数。長い応答でグラフのノードが間延びしないようにする。 */
export const MAX_SUMMARY_LENGTH = 120;

/**
 * ターンの完了後は `turnResultText`、進行中（ストリーミング中）は直近の `agentMessage` を使う。
 * どちらも無ければ空文字（「まだ応答が無い」の意味）を返す。
 */
export function buildResponseSummary(state: ChatState): string {
  const source =
    state.turnResultText !== '' ? state.turnResultText : lastNonEmptyAgentMessageText(state.items);
  return firstLineOf(source);
}

/** タスク定義のpromptを、一覧で読める1行の作業内容へ縮める（Issue #836/#849）。 */
export function buildTaskWorkSummary(prompt: string): string {
  return firstLineOf(prompt);
}

/**
 * 最初の空でない行を取り、制御文字（ANSIエスケープ・ゼロ幅文字・双方向制御文字を含む。
 * `sanitize.ts`のstripControlChars）を落としてから上限で省略する。改行以降は
 * 「1行要約」の趣旨から外れるため捨てる（レビュー指摘: low。エージェントの出力を
 * そのまま画面へ出す経路なので、`sanitizeForLog`と同じ無害化を通す）。
 */
function firstLineOf(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '') ?? '';
  const trimmed = stripControlChars(line).trim();
  return trimmed.length > MAX_SUMMARY_LENGTH ? `${trimmed.slice(0, MAX_SUMMARY_LENGTH)}…` : trimmed;
}

/* ---- 構造化サマリ（design.md §16.4、Issue #1271） ---- */

/**
 * `{{T1.brief}}` の材料（Issue #1271、親Issue #1270 Phase 1）。
 *
 * `{{T1.result}}`（応答全文）を下流のプロンプトへ貼るのをやめ、要点だけを渡すための形。
 * 1行要約（`buildResponseSummary`）では「何を決めたか」「何が未解決か」「成果物がどこに
 * あるか」が落ちるため、書き手が結局 `{{T1.result}}` を選んでいた、というのが出発点。
 *
 * **抽出は純粋関数で行い、モデルへは問い合わせない。** 応答本文の見出しと箇条書きという
 * 機械的に読める構造だけを拾う。Issue #1271はモデルによる抽出（セカンドオピニオン経路の
 * 流用）も選択肢として挙げているが、抽出のためにもう1セッション起こすと、削ろうとして
 * いるコンテキストとトークンを別の場所で使うことになる。まず機械的な抽出で足りるかを
 * 見てから判断する。
 */
export interface StructuredSummary {
  /** 1行要約（`buildResponseSummary` と同じ値）。 */
  summary: string;
  /** 決めたこと。 */
  decisions: string[];
  /** 未解決・判断待ち。 */
  openQuestions: string[];
  /** 変更したファイルのパス一覧（`ChatState.turnEditedFiles` をそのまま受け取る）。 */
  files: string[];
  /** 成果物の在り処（`read_handoff` へ渡す参照。`runner.ts` が組み立てて渡す）。 */
  artifacts: string[];
}

/** 1つの区分へ入れる最大件数。下流のプロンプトが積み上がらないよう、要点の数で抑える。 */
export const MAX_STRUCTURED_ITEMS = 5;

/** 構造化サマリの1項目の上限。1行要約と同じ長さに揃える。 */
export const MAX_STRUCTURED_ITEM_LENGTH = MAX_SUMMARY_LENGTH;

/** 見出しが「未解決・判断待ち」を表すとみなす語。 */
const OPEN_QUESTION_HEADINGS = ['未解決', '未確定', '懸念', '要検討', '課題', 'todo', 'open'];

/** 見出しが「決めたこと」を表すとみなす語。 */
const DECISION_HEADINGS = ['決定', '決めた', '方針', '結論', 'decision'];

/**
 * 見出しに寄らず、行そのものが未解決を表すとみなす語。
 *
 * 見出しを持たない応答（箇条書きだけを返すタスク）でも拾えるようにするためのもの。
 */
const OPEN_QUESTION_MARKERS = ['未解決', '要確認', '要検討', '懸念', 'todo:', 'todo：'];

/** `- ` / `* ` / `1. ` で始まる行から、記号を落とした本文を取り出す。箇条書きでなければ undefined。 */
function bulletBody(line: string): string | undefined {
  const m = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/u.exec(line);
  return m?.[1];
}

/** `#` 見出しの本文を取り出す。見出しでなければ undefined。 */
function headingBody(line: string): string | undefined {
  const m = /^\s*#{1,6}\s+(.*)$/u.exec(line);
  return m?.[1];
}

function matchesAny(text: string, keywords: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

/** 1項目ぶんの無害化と切り詰め。`firstLineOf` と同じ規則を1行の文字列へ適用する。 */
function normalizeItem(text: string): string {
  const trimmed = stripControlChars(text).trim();
  return trimmed.length > MAX_STRUCTURED_ITEM_LENGTH
    ? `${trimmed.slice(0, MAX_STRUCTURED_ITEM_LENGTH)}…`
    : trimmed;
}

function pushCapped(target: string[], value: string): void {
  const item = normalizeItem(value);
  if (item === '' || target.length >= MAX_STRUCTURED_ITEMS || target.includes(item)) {
    return;
  }
  target.push(item);
}

/**
 * 応答本文から決定事項と未解決事項を拾う。
 *
 * 見出しで区分が切り替わるとみなし、その配下の箇条書きを対応する区分へ入れる。区分を
 * 判定できない見出しの配下は「決めたこと」として扱う（応答の大半は結果の報告であり、
 * 未解決として扱うより誤りが少ない）。見出しが1つも無い応答では、箇条書きの行そのものを
 * 見て未解決の語を含むものだけ分け、残りを決めたことへ入れる。
 *
 * **これは体裁の推測であって、意味の理解ではない。** 箇条書きを使わない応答からは何も
 * 取れない。取れなければ空の配列を返し、呼び出し側（ワークフロー）は止めない。
 */
function extractSections(text: string): { decisions: string[]; openQuestions: string[] } {
  const decisions: string[] = [];
  const openQuestions: string[] = [];
  let section: 'decision' | 'open' | 'other' = 'other';

  for (const line of text.split('\n')) {
    const heading = headingBody(line);
    if (heading !== undefined) {
      section = matchesAny(heading, OPEN_QUESTION_HEADINGS)
        ? 'open'
        : matchesAny(heading, DECISION_HEADINGS)
          ? 'decision'
          : 'other';
      continue;
    }
    const bullet = bulletBody(line);
    if (bullet === undefined) {
      continue;
    }
    // 行そのものが未解決を表す場合は、どの区分の配下にあっても未解決として扱う
    if (section === 'open' || matchesAny(bullet, OPEN_QUESTION_MARKERS)) {
      pushCapped(openQuestions, bullet);
      continue;
    }
    pushCapped(decisions, bullet);
  }

  return { decisions, openQuestions };
}

/**
 * 構造化サマリを組み立てる（Issue #1271）。
 *
 * `buildResponseSummary` と同じく `ChatState` を読むだけの純粋関数で、`workspaceState` へは
 * 書かない（応答本文を永続化しない方針。design.md §16.11）。抽出に失敗しても例外は投げず、
 * 該当の区分が空の構造化サマリを返す。
 */
export function buildStructuredSummary(
  state: ChatState,
  input: { files: readonly string[]; artifacts: readonly string[] },
): StructuredSummary {
  const source =
    state.turnResultText !== '' ? state.turnResultText : lastNonEmptyAgentMessageText(state.items);
  const { decisions, openQuestions } = extractSections(source);
  // files / artifacts も他の区分と同じ件数・長さの上限に載せる。`{{T1.files}}` は一覧を
  // 全件渡す変数として残っており、`brief` は要点を渡す側なので、ここで膨らませない
  const files: string[] = [];
  for (const file of input.files) {
    pushCapped(files, file);
  }
  const artifacts: string[] = [];
  for (const artifact of input.artifacts) {
    pushCapped(artifacts, artifact);
  }
  return { summary: buildResponseSummary(state), decisions, openQuestions, files, artifacts };
}

/**
 * 構造化サマリを、下流のプロンプトへ差し込む短い文字列へ整形する（`{{T1.brief}}` の値）。
 *
 * ここで作るのは**囲いの中身だけ**で、区切り・nonce・制御文字の除去・全体の切り詰めは
 * `workflow.ts` の `wrapFreeTextField`（`untrustedText.ts` の `formatUntrusted`）が行う。
 * 上流のエージェントが書いた文字列を含むため、`{{T1.result}}` / `{{T1.summary}}` と同じ
 * 扱いにする（design.md §16.4 案3・案4）。
 *
 * 中身が1つも無い場合は空文字を返す。`formatUntrusted` は空文字を囲わないため、
 * 空の枠だけがプロンプトへ残ることはない。
 */
export function formatBrief(brief: StructuredSummary): string {
  const sections: string[] = [];
  if (brief.summary !== '') {
    sections.push(brief.summary);
  }
  for (const [label, items] of [
    ['決めたこと', brief.decisions],
    ['未解決', brief.openQuestions],
    ['変更したファイル', brief.files],
    ['成果物', brief.artifacts],
  ] as const) {
    if (items.length === 0) {
      continue;
    }
    sections.push([`${label}:`, ...items.map((item) => `- ${item}`)].join('\n'));
  }
  return sections.join('\n\n');
}
