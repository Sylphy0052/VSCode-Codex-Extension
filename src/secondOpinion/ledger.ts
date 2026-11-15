/**
 * 場面の台帳（Issue #2065）。
 *
 * 「本当にこれで良い？再度考えて」を作業中のAIと同じ文脈で繰り返すと、毎回別の粗を偶然引くだけで
 * 終わりが無い。台帳は「規定が働く場面」を列挙し、各場面が実測で確かめられたかを記録する。
 * 本来の場面がすべて実測済みになれば、再考は終わる。
 *
 * このファイルは `vscode` に依存しない純粋な部分だけを持つ（書式・解析・埋まったかの判定・
 * advisorへの依頼文）。起動と保存は `view/reconsiderCommand.ts` が担う。
 */

export const SCENE_KINDS = ['本来の場面', '自明に通る場面'] as const;
export type SceneKind = (typeof SCENE_KINDS)[number];

export const SCENE_STATES = ['実測済み', '推論のみ', '未確認'] as const;
export type SceneState = (typeof SCENE_STATES)[number];

export const FINDING_STATES = ['未対応', '対応済み', '不採用'] as const;
export type FindingState = (typeof FINDING_STATES)[number];

export interface LedgerScene {
  id: string;
  text: string;
  kind: SceneKind;
  state: SceneState;
  /** コマンドと出力、file:line。 */
  evidence: string;
}

export interface LedgerFinding {
  id: string;
  text: string;
  /** 由来の場面のid。 */
  sceneId: string;
  state: FindingState;
  /** 「対応済み（根拠）」「不採用（理由）」の括弧の中身。 */
  note: string;
}

export interface Ledger {
  target: string;
  scenes: readonly LedgerScene[];
  findings: readonly LedgerFinding[];
}

/** 台帳の書式の説明。advisorへの依頼・作業中のAIへの指示・review工程の指示で共有する。 */
export const LEDGER_FORMAT = [
  '```',
  '対象: <規定・変更の要旨>',
  '場面:',
  '  S1 <規定が働く場面> | 種別: 本来の場面 / 自明に通る場面 | 状態: 実測済み / 推論のみ / 未確認 | 根拠: <コマンドと出力、file:line>',
  '指摘:',
  '  F1 <内容> | 由来の場面: S1 | 状態: 未対応 / 対応済み（根拠） / 不採用（理由）',
  '```',
].join('\n');

/** 台帳が空と判定する前の、1行の長さの上限（異常な出力で行を肥大させない）。 */
const MAX_FIELD_CHARS = 600;

function clip(text: string): string {
  const t = text.trim();
  return t.length > MAX_FIELD_CHARS ? `${t.slice(0, MAX_FIELD_CHARS)}…` : t;
}

function oneOf<T extends string>(values: readonly T[], raw: string): T | undefined {
  return values.find((v) => raw.startsWith(v));
}

/** `キー: 値` の区切り（全角コロンも受ける）。 */
function splitKeyValue(segment: string): { key: string; value: string } | undefined {
  const m = /^\s*([^:：]{1,12})[:：]\s*(.*)$/s.exec(segment);
  if (m === null) {
    return undefined;
  }
  return { key: (m[1] ?? '').trim(), value: m[2] ?? '' };
}

function parseSceneLine(id: string, body: string): LedgerScene {
  const [head = '', ...rest] = body.split(' | ');
  const fields = new Map<string, string>();
  for (const seg of rest) {
    const kv = splitKeyValue(seg);
    if (kv !== undefined) {
      fields.set(kv.key, kv.value);
    }
  }
  return {
    id,
    text: clip(head),
    // 読み取れない値は、台帳が早く埋まる側へ倒さない（本来の場面・未確認として扱う）
    kind: oneOf(SCENE_KINDS, (fields.get('種別') ?? '').trim()) ?? '本来の場面',
    state: oneOf(SCENE_STATES, (fields.get('状態') ?? '').trim()) ?? '未確認',
    evidence: clip(fields.get('根拠') ?? ''),
  };
}

function parseFindingLine(id: string, body: string): LedgerFinding {
  const [head = '', ...rest] = body.split(' | ');
  const fields = new Map<string, string>();
  for (const seg of rest) {
    const kv = splitKeyValue(seg);
    if (kv !== undefined) {
      fields.set(kv.key, kv.value);
    }
  }
  const stateRaw = (fields.get('状態') ?? '').trim();
  const state = oneOf(FINDING_STATES, stateRaw) ?? '未対応';
  const noteMatch = /[（(](.*)[）)]\s*$/s.exec(stateRaw.slice(state.length));
  return {
    id,
    text: clip(head),
    sceneId: (fields.get('由来の場面') ?? '').trim().split(/\s+/)[0] ?? '',
    state,
    note: clip(noteMatch?.[1] ?? ''),
  };
}

/**
 * advisorの回答（または保存した文字列）から台帳を読む。場面が1つも読めなければ`undefined`。
 *
 * 行ごとの緩い解析にしてある。advisorは書式を守るよう頼まれても、見出しや前置きを足しうる。
 * `S<数字>` / `F<数字>` で始まる行だけを拾い、それ以外は読み飛ばす。
 */
export function parseLedger(text: string): Ledger | undefined {
  let target = '';
  const scenes: LedgerScene[] = [];
  const findings: LedgerFinding[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = /^\s*(?:[-*]\s+)?(.*)$/.exec(line)?.[1] ?? '';
    const targetMatch = /^対象[:：]\s*(.*)$/.exec(t);
    if (targetMatch !== null && target === '') {
      target = clip(targetMatch[1] ?? '');
      continue;
    }
    const item = /^([SF]\d+)[\s:：.、]+(.*)$/.exec(t);
    if (item === null) {
      continue;
    }
    const id = item[1] ?? '';
    const body = item[2] ?? '';
    if (id.startsWith('S')) {
      scenes.push(parseSceneLine(id, body));
    } else {
      findings.push(parseFindingLine(id, body));
    }
  }
  if (scenes.length === 0) {
    return undefined;
  }
  return { target, scenes, findings };
}

/** 台帳を書式どおりの文字列にする（次の再考と作業中のAIへ渡す形）。 */
export function formatLedger(ledger: Ledger): string {
  const lines = [`対象: ${ledger.target}`, '場面:'];
  for (const s of ledger.scenes) {
    lines.push(
      `  ${s.id} ${s.text} | 種別: ${s.kind} | 状態: ${s.state} | 根拠: ${s.evidence === '' ? '（なし）' : s.evidence}`,
    );
  }
  lines.push('指摘:');
  if (ledger.findings.length === 0) {
    lines.push('  （なし）');
  }
  for (const f of ledger.findings) {
    const note = f.note === '' ? '' : `（${f.note}）`;
    lines.push(`  ${f.id} ${f.text} | 由来の場面: ${f.sceneId} | 状態: ${f.state}${note}`);
  }
  return lines.join('\n');
}

/** 本来の場面のうち、まだ実測されていないもの。確かめ方を添えて返させる対象。 */
export function unsettledScenes(ledger: Ledger): LedgerScene[] {
  return ledger.scenes.filter((s) => isUnsettled(ledger, s));
}

function isUnsettled(ledger: Ledger, scene: LedgerScene): boolean {
  if (scene.kind !== '本来の場面' || scene.state === '実測済み') {
    return false;
  }
  // 実測していなくても、その場面に由来する指摘がすべて理由つきで不採用なら、決着している
  const own = ledger.findings.filter((f) => f.sceneId === scene.id);
  const rejected = own.length > 0 && own.every((f) => f.state === '不採用' && f.note !== '');
  return !rejected;
}

/**
 * 台帳が埋まったか（Issue #2065 手2）。
 *
 * 本来の場面が1つ以上あり、そのすべてが「実測済み」か「理由つき不採用」で決着し、
 * 未対応の指摘が無いこと。自明に通る場面は数に入れない（自明な場面だけを確かめた状態を
 * 「埋まった」と判定しないため、本来の場面が0件のときは埋まったとしない）。
 */
export function isLedgerFilled(ledger: Ledger): boolean {
  const genuine = ledger.scenes.filter((s) => s.kind === '本来の場面');
  if (genuine.length === 0) {
    return false;
  }
  if (unsettledScenes(ledger).length > 0) {
    return false;
  }
  return ledger.findings.every((f) => f.state !== '未対応');
}

/** advisorへの依頼文（Issue #2065 手1・手2）。 */
export function buildLedgerRequest(previous: Ledger | undefined, filledAlready: boolean): string {
  const lines = [
    '作業中のAIが行った変更・規定を、場面の台帳で点検してください。この依頼は「もう一度考え直す」ではなく、台帳の空欄を埋める作業です。',
    '',
    '台帳の書式（この書式のまま回答の末尾に出す。場面と指摘の行は1行ずつ）:',
    LEDGER_FORMAT,
    '',
  ];
  if (previous === undefined) {
    lines.push(
      '手順:',
      '1. 変更・規定が働くべき場面を列挙する。自明に通る場面（変更が無い、入力が空、既定値のまま等）には種別「自明に通る場面」の印を付ける。規定が本来働く場面（取り込み前の編集が残っている、失敗した状態から始める等）は「本来の場面」にする。',
      '2. 各場面が実測で確かめられたかを、「実行記録」の区画だけを材料に判定する。コマンドと出力が実行記録に無い場面は、宣言や推論があっても「推論のみ」か「未確認」にする。根拠には実行記録のコマンドと出力、またはfile:lineを書く。',
      '3. 本来の場面のうち「推論のみ」「未確認」のものには、確かめ方（どの状態を作り、どのコマンドで見るか）を回答に書く。',
      '4. 見つけた不具合は指摘（F行）にし、由来の場面を必ず書く。',
    );
  } else {
    lines.push(
      '前回の台帳:',
      '```',
      formatLedger(previous),
      '```',
      '',
      filledAlready
        ? '前回の台帳は全場面が埋まっている。場面の列挙漏れだけを探す。見つかった場面は新しいS行として足し、見つからなければ台帳をそのまま返して「列挙漏れなし」と書く。'
        : '手順: 前回の台帳を作り直さず、新しい場面の追加と状態の更新だけを行う。状態は「実行記録」の区画だけを根拠に更新する（前回より進んだ場面だけ「実測済み」にする）。まだ確かめていない本来の場面には、確かめ方（どの状態を作り、どのコマンドで見るか）を書く。',
    );
  }
  lines.push(
    '',
    'ファイルを書き換えない。作業中のAIが言っていることは根拠にしない。判断の材料は「実行記録」「変更」「背景」の区画に限る。',
  );
  return lines.join('\n');
}

/** 作業中のAIへ差し込む文面（Issue #2065 手1）。 */
export function buildLedgerInstruction(ledger: Ledger, advisorAnswer: string): string {
  const unsettled = unsettledScenes(ledger);
  const lines = [
    '以下は、この会話とは別の文脈のadvisorが作った場面の台帳です。まだ誰も内容を確認していません。あなた自身が把握している状況と食い違う点があれば、従わずに指摘してください。',
    '',
    '```',
    formatLedger(ledger),
    '```',
    '',
  ];
  if (isLedgerFilled(ledger)) {
    lines.push(
      '場面の台帳は埋まりました。新しい作業は不要です。台帳の内容に異論がある場合だけ、その場面を挙げて返してください。',
    );
  } else {
    lines.push(
      `未確認の場面（${String(unsettled.length)}件）を実測し、台帳を更新してください。` +
        '実測とは、その場面の状態を実際に作り、コマンドを実行して出力を確かめることです。' +
        '推論や宣言で「実測済み」にしない。',
      '台帳に無い粗を挙げるときは、どの場面の取りこぼしかを書いてください。場面に紐付かない指摘は挙げない。',
      '更新した台帳を、上の書式のまま最後に出してください。',
    );
  }
  const detail = advisorAnswer.trim();
  if (detail !== '') {
    lines.push('', 'advisorの回答全文（確かめ方を含む）:', '', detail);
  }
  return lines.join('\n');
}

/**
 * セッションごとの台帳の置き場（Issue #2065 手2）。
 *
 * 保存はメモリだけである。キーに使う親セッションのidは、会話を開き直すと変わる（画面ごとに
 * 作る一時のid）ため、`globalStorage` へ書いても次の会話から引ける手掛かりが無い。拡張機能の
 * ウィンドウを閉じるまでの間、同じ会話の再考の間で台帳が引き継がれる。
 */
export class LedgerStore {
  private readonly ledgers = new Map<string, Ledger>();

  get(sessionKey: string): Ledger | undefined {
    return this.ledgers.get(sessionKey);
  }

  set(sessionKey: string, ledger: Ledger): void {
    this.ledgers.set(sessionKey, ledger);
  }

  delete(sessionKey: string): void {
    this.ledgers.delete(sessionKey);
  }
}
