import type { McLifecycleOp, McRunOp, McRunTaskOp } from './protocol';

/**
 * Mission Controlのキー割り当て（Issue #2136の5・#2152）。
 *
 * キーの判定（`mapKey`）・ヘルプの一覧（`KEY_HELP`）・コマンドパレットの項目は、どれも
 * `KEY_BINDINGS`の表から作る。表の外でキーを判定しないので、ヘルプと実際の割り当てがずれない。
 * DOMの型もPreactも使わない（単体テストから直接呼ぶ）。
 */

/** キーボード操作で起きること。 */
export type McKeyCommand =
  | { kind: 'next' }
  | { kind: 'prev' }
  | { kind: 'detail' }
  | { kind: 'choose'; index: number }
  | { kind: 'approve' }
  | { kind: 'decline' }
  | { kind: 'reply' }
  | { kind: 'search' }
  | { kind: 'help' }
  | { kind: 'newSession' }
  | { kind: 'escape' }
  // Issue #2149: 複数選択・閉じる・archive・delete・履歴
  | { kind: 'toggleMark' }
  | { kind: 'lifecycle'; op: McLifecycleOp }
  | { kind: 'history' }
  // Issue #2150: Runsタブ・roadmapからの起動
  | { kind: 'tab' }
  | { kind: 'runOp'; op: McRunOp }
  | { kind: 'parallel'; delta: 1 | -1 }
  | { kind: 'issues' }
  // Issue #2152: ペインの移動・コマンドパレット・アクセスキーの表示・送信
  | { kind: 'pane'; delta: 1 | -1 }
  | { kind: 'palette' }
  | { kind: 'accessKeys' }
  | { kind: 'submit' }
  // Issue #2151: 一覧 / カードの切り替え・密度の切り替え
  | { kind: 'view' }
  | { kind: 'density' }
  // Issue #2157: 詳細ペインの会話（検索・一致の移動・ツール / diffの開閉・古いやり取り）
  | { kind: 'turnSearch' }
  | { kind: 'turnMatch' }
  | { kind: 'turnMatchPrev' }
  | { kind: 'turnFolds' }
  | { kind: 'turnOlder' }
  // Issue #2158: 指示欄（Composer）の添付・送信キュー
  | { kind: 'attach' }
  | { kind: 'queue' }
  // 実行中セッションの設定（Issue #2159）
  | { kind: 'settings' }
  | { kind: 'planMode' }
  | { kind: 'fastMode' }
  // 選んだセッションへのrename・fork・pin・clear・引き継ぎ・巻き戻し（Issue #2160）
  | { kind: 'sessionOp'; op: McSessionOp }
  // 費用・利用枠・MCの設定・絞り込みの保存・runのタスク単位の操作（Issue #2162）
  | { kind: 'usage' }
  | { kind: 'prefs' }
  | { kind: 'saveFilter' }
  | { kind: 'savedFilter'; delta: 1 | -1 }
  | { kind: 'deleteFilter' }
  | { kind: 'task'; delta: 1 | -1 }
  | { kind: 'taskOp'; op: McRunTaskOp };

/** 選んだセッションへの操作（Issue #2160）。`pin`はピン留めの付け外しを切り替える。 */
export type McSessionOp = 'rename' | 'fork' | 'pin' | 'clear' | 'handoff' | 'rewind';

export interface McKeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /**
   * Shiftが押されているか。英字はこれで大文字の操作（Shift+Dの削除など）を見分ける。CapsLockが
   * 有効だと`key`はShift無しでも大文字で届くため、`key`の大小では判定しない。
   */
  shiftKey?: boolean | undefined;
  /** 入力欄にフォーカスがあるか。あるときは`Escape`と`Ctrl+Enter`以外を文字入力として通す。 */
  inEditable: boolean;
}

/**
 * キーの割り当て1件。
 *
 * `keys`は`KeyboardEvent.key`の値。英字は小文字で書き、Shiftが要るものは`Shift+d`のように前に
 * 付ける。`Ctrl+`はCtrlかCmd（mac）。Shiftを見分けるのは英字と`Tab`だけで、`?`・`:`・`+`の
 * ようにShiftで打つ記号はShiftの有無を問わない（配列ごとにShiftの要否が違うため）。
 */
export interface McKeyBinding {
  keys: readonly string[];
  /** ヘルプに出すキーの表記。省くと`keys`から作る。 */
  display?: string;
  label: string;
  /** Runsタブで意味が変わるときの説明。ヘルプに「（Runs）」の行を足す。 */
  runsLabel?: string;
  /** `runs`ならRunsタブだけで効く。セッションのタブでは詳細ペインのアクセスキーに譲る。 */
  scope?: 'runs';
  /** 選んでいる項目に効く操作か（パレットで上に出す）。 */
  contextual?: boolean;
  /** パレットに出さない（Esc・パレット自身・数字のように、名前で選んでも意味が無いもの）。 */
  hideInPalette?: boolean;
  command: McKeyCommand | ((key: string) => McKeyCommand);
}

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

export const KEY_BINDINGS: readonly McKeyBinding[] = [
  {
    keys: ['j', 'ArrowDown'],
    label: '次の項目（repo一覧ではrepoを選ぶ）',
    runsLabel: '次のrun',
    command: { kind: 'next' },
  },
  {
    keys: ['k', 'ArrowUp'],
    label: '前の項目（repo一覧ではrepoを選ぶ）',
    runsLabel: '前のrun',
    command: { kind: 'prev' },
  },
  {
    keys: ['Tab', 'ArrowRight'],
    label: '右のペインへ移る（repo一覧 → 一覧 → 詳細）',
    command: { kind: 'pane', delta: 1 },
  },
  {
    keys: ['Shift+Tab', 'ArrowLeft'],
    label: '左のペインへ移る',
    command: { kind: 'pane', delta: -1 },
  },
  {
    keys: ['Enter'],
    label: '詳細へ移る（repo一覧では一覧へ移る）',
    runsLabel: 'runへ切り替える（KanbanとOrchestratorを前面へ）',
    contextual: true,
    command: { kind: 'detail' },
  },
  {
    keys: DIGITS,
    display: '1〜9',
    label: '選択肢を選ぶ',
    hideInPalette: true,
    command: (key) => ({ kind: 'choose', index: Number(key) - 1 }),
  },
  { keys: ['a'], label: '承認 / 回答を送る', contextual: true, command: { kind: 'approve' } },
  { keys: ['d'], label: '拒否', contextual: true, command: { kind: 'decline' } },
  {
    keys: ['r'],
    label: '返信欄・指示欄へ移る',
    contextual: true,
    command: { kind: 'reply' },
  },
  {
    keys: ['n'],
    label: '新規セッション',
    runsLabel: '新しいrunを始める',
    command: { kind: 'newSession' },
  },
  {
    keys: ['x'],
    label: 'セッションの複数選択を切り替える',
    contextual: true,
    command: { kind: 'toggleMark' },
  },
  {
    keys: ['c'],
    label: 'セッションを閉じる（実行中なら確認）',
    contextual: true,
    command: { kind: 'lifecycle', op: 'close' },
  },
  {
    keys: ['e'],
    label: 'セッションをarchive（実行中なら確認）',
    contextual: true,
    command: { kind: 'lifecycle', op: 'archive' },
  },
  {
    // 取り消せない削除は、拒否の`d`と取り違えないようShift付きにする
    keys: ['Shift+d'],
    label: 'セッションを削除（必ず確認）',
    contextual: true,
    command: { kind: 'lifecycle', op: 'delete' },
  },
  {
    keys: ['h'],
    label: '履歴を開く（↑ / ↓で移動、Enterで再開）',
    command: { kind: 'history' },
  },
  { keys: ['t'], label: 'セッション / Runsのタブを切り替える', command: { kind: 'tab' } },
  {
    keys: ['o'],
    label: 'runへ切り替える（KanbanとOrchestratorを前面へ）',
    scope: 'runs',
    contextual: true,
    command: { kind: 'runOp', op: 'switch' },
  },
  {
    keys: ['p'],
    label: 'runを一時停止 / 一時停止を解く',
    scope: 'runs',
    contextual: true,
    command: { kind: 'runOp', op: 'pause' },
  },
  {
    keys: ['z'],
    label: 'runを中断（確認あり）',
    scope: 'runs',
    contextual: true,
    command: { kind: 'runOp', op: 'suspend' },
  },
  {
    keys: ['u'],
    label: '中断したrunを再開',
    scope: 'runs',
    contextual: true,
    command: { kind: 'runOp', op: 'resume' },
  },
  {
    // runを終える操作も取り消せない（終えたrunは再開できない）
    keys: ['Shift+f'],
    label: 'runを終える（必ず確認）',
    scope: 'runs',
    contextual: true,
    command: { kind: 'runOp', op: 'finish' },
  },
  {
    keys: ['+', '='],
    label: 'runの並列上限を1つ上げる',
    scope: 'runs',
    contextual: true,
    command: { kind: 'parallel', delta: 1 },
  },
  {
    keys: ['-'],
    label: 'runの並列上限を1つ下げる',
    scope: 'runs',
    contextual: true,
    command: { kind: 'parallel', delta: -1 },
  },
  {
    keys: ['i'],
    label: 'roadmap・Issueから起動（j / kで移動、xで選択、Enterで起動、fでフォルダ、gでCLI）',
    command: { kind: 'issues' },
  },
  { keys: ['v'], label: 'セッションの一覧 / カードを切り替える', command: { kind: 'view' } },
  {
    // 一覧 / カードの`v`と対にする（Shift付きなので詳細ペインのアクセスキーを減らさない）
    keys: ['Shift+v'],
    label: '表示の密度（標準 / コンパクト）を切り替える',
    command: { kind: 'density' },
  },
  { keys: ['/'], label: '検索', command: { kind: 'search' } },
  // 会話の操作はShift付きにする（詳細ペインのアクセスキーに使う英字を減らさない。Issue #2157）
  {
    keys: ['Shift+s'],
    label: '会話内を検索（入力欄ではEnter / Shift+Enterで一致を移動）',
    contextual: true,
    command: { kind: 'turnSearch' },
  },
  {
    keys: ['Shift+n'],
    label: '会話内の次の一致へ',
    contextual: true,
    command: { kind: 'turnMatch' },
  },
  {
    keys: ['Shift+p'],
    label: '会話内の前の一致へ',
    contextual: true,
    command: { kind: 'turnMatchPrev' },
  },
  {
    keys: ['Shift+e'],
    label: '会話のツール呼び出し・diffをまとめて開く / 閉じる',
    contextual: true,
    command: { kind: 'turnFolds' },
  },
  {
    keys: ['Shift+o'],
    label: '会話の古いやり取りを読み足す（上端までスクロールしても読み足す）',
    contextual: true,
    command: { kind: 'turnOlder' },
  },
  // 指示欄の操作もShift付きにする（Issue #2158。アクセスキーの英字を減らさない）
  {
    keys: ['Shift+a'],
    label: '指示に添付するファイルを選ぶ（画像は画像として、ほかは@パスとして）',
    contextual: true,
    command: { kind: 'attach' },
  },
  {
    keys: ['Shift+q'],
    label: '送信キューを開く / 閉じる（↑ / ↓で移動、Deleteで取り消す）',
    contextual: true,
    command: { kind: 'queue' },
  },
  // 実行中セッションの設定もShift付きにする（Issue #2159。アクセスキーの英字を減らさない）
  {
    keys: ['Shift+m'],
    label:
      '設定欄へ移る（model・effort・承認レベルを↑ / ↓で選び、Ctrl+Enterで変更する。次のターンから効く）',
    contextual: true,
    command: { kind: 'settings' },
  },
  {
    keys: ['Shift+l'],
    label: 'Plan modeに入る / 抜ける（次のターンから効く）',
    contextual: true,
    command: { kind: 'planMode' },
  },
  {
    keys: ['Shift+t'],
    label: 'Fast modeを切り替える（Claudeだけ）',
    contextual: true,
    command: { kind: 'fastMode' },
  },
  // 選んだセッションへの操作もShift付きにする（Issue #2160。アクセスキーの英字を減らさない）
  {
    keys: ['Shift+r'],
    label: '選んだセッションの名前を変える',
    contextual: true,
    command: { kind: 'sessionOp', op: 'rename' },
  },
  {
    keys: ['Shift+b'],
    label: '選んだセッションを分岐する（会話全体を複製した新しいセッションを開く）',
    contextual: true,
    command: { kind: 'sessionOp', op: 'fork' },
  },
  {
    keys: ['Shift+i'],
    label: '選んだセッションをピン留めする / 外す',
    contextual: true,
    command: { kind: 'sessionOp', op: 'pin' },
  },
  {
    keys: ['Shift+c'],
    label: '選んだセッションの会話をクリアする（確認を出す）',
    contextual: true,
    command: { kind: 'sessionOp', op: 'clear' },
  },
  {
    keys: ['Shift+h'],
    label: '選んだセッションを新しいセッションへ引き継ぐ',
    contextual: true,
    command: { kind: 'sessionOp', op: 'handoff' },
  },
  {
    keys: ['Shift+z'],
    label: '選んだセッションを発言の時点まで巻き戻す（Claudeだけ。確認を出す）',
    contextual: true,
    command: { kind: 'sessionOp', op: 'rewind' },
  },
  // Issue #2162: 費用・利用枠・設定・絞り込みの保存。英字はShift付きにする（アクセスキーを減らさない）
  {
    keys: ['Shift+u'],
    label: '費用と利用枠の詳細を開く / 閉じる',
    command: { kind: 'usage' },
  },
  {
    keys: [','],
    label: 'Mission Controlの設定（停滞・返事待ちの閾値、通知）を開く',
    command: { kind: 'prefs' },
  },
  {
    keys: ['Shift+w'],
    label: '今の絞り込みに名前を付けて保存する（同じ名前は上書き）',
    command: { kind: 'saveFilter' },
  },
  {
    keys: [']'],
    label: '保存した絞り込みの次へ切り替える',
    command: { kind: 'savedFilter', delta: 1 },
  },
  {
    keys: ['['],
    label: '保存した絞り込みの前へ切り替える',
    command: { kind: 'savedFilter', delta: -1 },
  },
  {
    keys: ['Shift+x'],
    label: '今の保存した絞り込みを削除する',
    command: { kind: 'deleteFilter' },
  },
  {
    keys: ['Shift+j'],
    label: 'runの次のタスクを選ぶ',
    scope: 'runs',
    command: { kind: 'task', delta: 1 },
  },
  {
    keys: ['Shift+k'],
    label: 'runの前のタスクを選ぶ',
    scope: 'runs',
    command: { kind: 'task', delta: -1 },
  },
  {
    keys: ['Shift+g'],
    label: '選んだタスクの工程をやり直す（Kanbanの「やり直す」と同じ）',
    scope: 'runs',
    contextual: true,
    command: { kind: 'taskOp', op: 'retry' },
  },
  {
    keys: ['Shift+y'],
    label: '選んだタスクの工程を停止する（確認あり）',
    scope: 'runs',
    contextual: true,
    command: { kind: 'taskOp', op: 'stop' },
  },
  {
    keys: [':'],
    label: 'コマンドパレット（操作を名前で選ぶ）',
    hideInPalette: true,
    command: { kind: 'palette' },
  },
  {
    keys: ['.'],
    label: 'ボタン上のキー表示を切り替える',
    command: { kind: 'accessKeys' },
  },
  { keys: ['?'], label: 'この一覧', command: { kind: 'help' } },
  {
    keys: ['Ctrl+Enter'],
    label: 'フォーム・ダイアログを送信する',
    hideInPalette: true,
    command: { kind: 'submit' },
  },
  {
    keys: ['Escape'],
    label: '閉じる / 複数選択を外す / 入力欄から出る',
    hideInPalette: true,
    command: { kind: 'escape' },
  },
];

interface KeySpec {
  key: string;
  shift: boolean;
  ctrl: boolean;
}

/** `Shift+d`・`Ctrl+Enter`のような表記を分解する。 */
export function parseKeySpec(spec: string): KeySpec {
  let rest = spec;
  let shift = false;
  let ctrl = false;
  for (;;) {
    if (rest.startsWith('Shift+') && rest.length > 'Shift+'.length) {
      shift = true;
      rest = rest.slice('Shift+'.length);
    } else if (rest.startsWith('Ctrl+') && rest.length > 'Ctrl+'.length) {
      ctrl = true;
      rest = rest.slice('Ctrl+'.length);
    } else {
      return { key: rest, shift, ctrl };
    }
  }
}

function isLetter(key: string): boolean {
  return /^[A-Za-z]$/u.test(key);
}

/** Shiftの有無で別の操作になるキーか。英字と`Tab`だけ（記号は配列ごとにShiftの要否が違う）。 */
function isShiftSignificant(key: string): boolean {
  return isLetter(key) || key === 'Tab';
}

const KEY_NAMES: Record<string, string> = {
  ArrowDown: '↓',
  ArrowUp: '↑',
  ArrowLeft: '←',
  ArrowRight: '→',
  Escape: 'Esc',
};

function displaySpec(spec: string): string {
  const { key, shift, ctrl } = parseKeySpec(spec);
  const name = KEY_NAMES[key] ?? (isLetter(key) && shift ? key.toUpperCase() : key);
  return `${ctrl ? 'Ctrl+' : ''}${shift ? 'Shift+' : ''}${name}`;
}

/** ヘルプ・パレットに出すキーの表記。 */
export function bindingDisplay(binding: McKeyBinding): string {
  return binding.display ?? binding.keys.map(displaySpec).join(' / ');
}

/**
 * 操作に割り当てたキーの表記（空の状態の案内などに出す）。表から引くので、割り当てを変えても
 * 案内がずれない。割り当てが無ければ`undefined`。
 */
export function keyLabelFor(kind: McKeyCommand['kind']): string | undefined {
  const binding = KEY_BINDINGS.find(
    (b) => typeof b.command !== 'function' && b.command.kind === kind,
  );
  return binding === undefined ? undefined : bindingDisplay(binding);
}

export interface McResolvedKey {
  binding: McKeyBinding;
  command: McKeyCommand;
}

function commandOf(binding: McKeyBinding, key: string): McKeyCommand {
  return typeof binding.command === 'function' ? binding.command(key) : binding.command;
}

/** 押されたキーに当たる割り当てを表から探す。 */
export function resolveKey(input: McKeyInput): McResolvedKey | undefined {
  // 英字はShiftの有無だけで見分け、CapsLockで大文字になったものはShift無しの操作として扱う
  const key = isLetter(input.key) ? input.key.toLowerCase() : input.key;
  // Escは修飾キーを問わない（今までの挙動）
  if (input.altKey && key !== 'Escape') {
    return undefined;
  }
  const ctrl = input.ctrlKey || input.metaKey;
  const shift = input.shiftKey === true;
  // 入力欄の中でも効くのはEscと送信だけ。ほかは文字入力として通す
  const worksInEditable = key === 'Escape' || (key === 'Enter' && ctrl);
  if (input.inEditable && !worksInEditable) {
    return undefined;
  }
  for (const binding of KEY_BINDINGS) {
    for (const raw of binding.keys) {
      const spec = parseKeySpec(raw);
      if (spec.key !== key) {
        continue;
      }
      if (key !== 'Escape' && spec.ctrl !== ctrl) {
        continue;
      }
      if (isShiftSignificant(key) && spec.shift !== shift) {
        continue;
      }
      return { binding, command: commandOf(binding, key) };
    }
  }
  return undefined;
}

export function mapKey(input: McKeyInput): McKeyCommand | undefined {
  return resolveKey(input)?.command;
}

/** 画面に出すキーの一覧（`?`）。`KEY_BINDINGS`から作る。 */
export const KEY_HELP: ReadonlyArray<readonly [string, string]> = KEY_BINDINGS.flatMap(
  (binding): Array<readonly [string, string]> => {
    const display = bindingDisplay(binding);
    const label = binding.scope === 'runs' ? `${binding.label}（Runs）` : binding.label;
    const rows: Array<readonly [string, string]> = [[display, label]];
    if (binding.runsLabel !== undefined) {
      rows.push([`${display}（Runs）`, binding.runsLabel]);
    }
    return rows;
  },
);

/**
 * 指示欄（Composer）の中で効くキー（Issue #2158）。入力欄の中のキーは`resolveKey`が文字入力として
 * 通すため、指示欄が自分で受け持つ。表に入れず、ヘルプに別の表として出す。
 */
export const COMPOSER_KEY_HELP: ReadonlyArray<readonly [string, string]> = [
  ['Ctrl+V', '指示欄: 画像を貼り付けて添付する'],
  ['@', '指示欄: ファイルの候補を出す（続けて打つと絞り込む）'],
  ['/（行頭）', '指示欄: スラッシュコマンドの候補を出す'],
  ['↑ / ↓', '指示欄の候補: 選ぶ'],
  ['Enter / Tab', '指示欄の候補: 入れる'],
  ['Esc', '指示欄の候補: 閉じる'],
  ['Ctrl+Enter', '指示欄: 送る（応答中なら送信キューへ入る）'],
  ['↑ / ↓・Delete', '送信キュー: 選ぶ・取り消す'],
];

/**
 * タブで効いている英字（Shift無し）。詳細ペインのアクセスキーはこれ以外から選ぶ。
 * セッションのタブでは、Runsタブだけで効く英字（`o`・`p`など）もアクセスキーに使える。
 */
export function boundLetters(tab: 'sessions' | 'runs'): ReadonlySet<string> {
  const letters = new Set<string>();
  for (const binding of KEY_BINDINGS) {
    if (binding.scope === 'runs' && tab !== 'runs') {
      continue;
    }
    for (const raw of binding.keys) {
      const spec = parseKeySpec(raw);
      if (isLetter(spec.key) && !spec.shift && !spec.ctrl) {
        letters.add(spec.key);
      }
    }
  }
  return letters;
}

/** アクセスキーに使う英字の順（打ちやすいものを先に）。 */
const ACCESS_KEY_ORDER = 'sfgwbvmqyluozpacdehijknrtx';

/**
 * ボタンなどにアクセスキーを順に割り当てる。`reserved`の英字は使わない。英字が尽きたら
 * 残りは`undefined`（アクセスキー無し。Tabかパレットで届く）。
 */
export function assignAccessKeys(
  count: number,
  reserved: ReadonlySet<string>,
): Array<string | undefined> {
  const pool = [...ACCESS_KEY_ORDER].filter((letter) => !reserved.has(letter));
  return Array.from({ length: count }, (_, index) => pool[index]);
}

/** コマンドパレットの1項目（Issue #2152の1）。 */
export interface McPaletteEntry {
  id: string;
  label: string;
  /** キーの表記（あれば右に出す）。 */
  keyLabel?: string | undefined;
  /** 選んでいるセッション・項目に効く操作。上に出す。 */
  contextual: boolean;
  run: () => void;
}

/**
 * 絞り込みと並べ替え。語を空白で区切り、すべてを名前かキーの表記に含む項目を残す。
 * 選んでいる項目に効く操作を上へ、同じ組の中では元の順を保つ。
 */
export function filterPalette(entries: readonly McPaletteEntry[], query: string): McPaletteEntry[] {
  const words = query
    .toLowerCase()
    .split(/\s+/u)
    .filter((w) => w !== '');
  const matched = entries.filter((entry) => {
    const haystack = `${entry.label} ${entry.keyLabel ?? ''}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
  return [
    ...matched.filter((entry) => entry.contextual),
    ...matched.filter((entry) => !entry.contextual),
  ];
}
