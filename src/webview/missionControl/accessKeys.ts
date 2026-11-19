import { assignAccessKeys, boundLetters } from './keys';

/**
 * 詳細ペインとダイアログのボタンへ、英字1つのアクセスキーを割り当てる（Issue #2152の3）。
 *
 * ボタンはセッションの種類・状態ごとに増減するので、描画のたびにDOMを見て割り当て直す。
 * - 全体のキー（`j`・`a`など）と同じ意味のボタンは、JSXで`data-key-label`を付けて表示だけする
 * - それ以外のボタン・入力欄に、空いている英字を上から順に`data-akey`で付ける
 * - キーの表示は`data-akey-badge`（ボタンならそれ自身、入力欄なら囲みの`<label>`）に置き、
 *   CSSの`::after`で出す。入力欄は`::after`を描けないため
 */

const ACTIONABLE = 'button, input:not([type="hidden"]), select, textarea, summary, a[href]';

/** 今アクセスキーが効く範囲。一番上のダイアログ、無ければセッションのタブの詳細ペイン。 */
export function accessKeyScope(root: ParentNode): HTMLElement | null {
  const dialogs = root.querySelectorAll<HTMLElement>('[role="dialog"]');
  const top = dialogs[dialogs.length - 1];
  if (top !== undefined) {
    return top;
  }
  return root.querySelector<HTMLElement>('.mc[data-tab="sessions"] [data-pane="detail"]');
}

/** ダイアログが自分で使う英字（`data-reserved-keys="jkx"`）。アクセスキーに使わない。 */
function reservedFor(scope: HTMLElement): ReadonlySet<string> {
  if (scope.getAttribute('role') === 'dialog') {
    const own = scope.querySelector<HTMLElement>('[data-reserved-keys]') ?? scope;
    return new Set([...(own.dataset['reservedKeys'] ?? '')]);
  }
  return boundLetters('sessions');
}

function isUsable(element: HTMLElement): boolean {
  if ((element as HTMLButtonElement).disabled === true) {
    return false;
  }
  if (element.closest('[data-key-label]') !== null || element.closest('[data-no-akey]') !== null) {
    return false;
  }
  // 閉じた<details>の中身は見えない（<summary>だけは見える）
  const details = element.closest('details');
  if (details !== null && !details.open && element.tagName !== 'SUMMARY') {
    return false;
  }
  return true;
}

function badgeHost(element: HTMLElement): HTMLElement | null {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  ) {
    // labelで囲まれていない入力欄（脇道の質問のtextareaなど）は、直上の親に表示する
    return element.closest('label') ?? element.parentElement;
  }
  return element;
}

/** 詳細ペインの入力欄（パレットの「入力欄へフォーカス」用）。 */
export function scopeInputs(root: ParentNode): Array<{ label: string; element: HTMLElement }> {
  const scope = accessKeyScope(root);
  if (scope === null || scope.getAttribute('role') === 'dialog') {
    return [];
  }
  const inputs: Array<{ label: string; element: HTMLElement }> = [];
  for (const element of scope.querySelectorAll<HTMLElement>(
    'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, select',
  )) {
    if (!isUsable(element)) {
      continue;
    }
    const label = (
      element.getAttribute('aria-label') ??
      element.getAttribute('placeholder') ??
      element.getAttribute('title') ??
      element.closest('label')?.textContent ??
      ''
    )
      .replace(/\s+/gu, ' ')
      .trim();
    inputs.push({ label: label === '' ? '入力欄' : label, element });
  }
  return inputs;
}

/**
 * 詳細ペインの中のTabを標準の移動に任せるか。ペインの中の押せる要素の端でなければtrue。
 * 端（または枠自身）ではfalseを返し、呼び出し側がペイン移動にする。
 */
export function tabStaysInPane(pane: HTMLElement, backward: boolean): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === pane || !pane.contains(active)) {
    return false;
  }
  const focusables = [...pane.querySelectorAll<HTMLElement>(ACTIONABLE)].filter(
    (element) => (element as HTMLButtonElement).disabled !== true && element.tabIndex >= 0,
  );
  const edge = backward ? focusables[0] : focusables[focusables.length - 1];
  return edge !== undefined && active !== edge;
}

/** アクセスキーを割り当て直す。範囲の外に残った前回の割り当ては消す。 */
export function refreshAccessKeys(root: ParentNode): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-akey]')) {
    element.removeAttribute('data-akey');
  }
  for (const element of root.querySelectorAll<HTMLElement>('[data-akey-badge]')) {
    element.removeAttribute('data-akey-badge');
  }
  const scope = accessKeyScope(root);
  if (scope === null) {
    return;
  }
  const targets = [...scope.querySelectorAll<HTMLElement>(ACTIONABLE)].filter(isUsable);
  const letters = assignAccessKeys(targets.length, reservedFor(scope));
  targets.forEach((element, index) => {
    const letter = letters[index];
    if (letter === undefined) {
      return;
    }
    element.setAttribute('data-akey', letter);
    const host = badgeHost(element);
    if (host !== null && !host.hasAttribute('data-akey-badge')) {
      host.setAttribute('data-akey-badge', letter);
    }
  });
}

/** 英字に当たるアクセスキーの要素を押す（入力欄ならフォーカスする）。押せたらtrue。 */
export function activateAccessKey(root: ParentNode, letter: string): boolean {
  const scope = accessKeyScope(root);
  if (!/^[a-z]$/u.test(letter)) {
    return false;
  }
  const element = scope?.querySelector<HTMLElement>(`[data-akey="${letter}"]`);
  if (element === null || element === undefined) {
    return false;
  }
  const isToggle =
    element instanceof HTMLInputElement &&
    (element.type === 'checkbox' || element.type === 'radio');
  if (
    !isToggle &&
    (element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement)
  ) {
    element.focus();
    return true;
  }
  element.focus();
  element.click();
  return true;
}

/** 今の範囲で押せる操作（パレットに出す）。名前はaria-label・title・文字の順に取る。 */
export function scopeActions(root: ParentNode): Array<{ label: string; element: HTMLElement }> {
  const scope = accessKeyScope(root);
  if (scope === null || scope.getAttribute('role') === 'dialog') {
    return [];
  }
  const actions: Array<{ label: string; element: HTMLElement }> = [];
  for (const element of scope.querySelectorAll<HTMLElement>('button, summary')) {
    if (!isUsable(element)) {
      continue;
    }
    const label = (
      element.getAttribute('aria-label') ??
      element.getAttribute('title') ??
      element.textContent ??
      ''
    )
      .replace(/\s+/gu, ' ')
      .trim();
    if (label !== '') {
      actions.push({ label, element });
    }
  }
  return actions;
}

/**
 * `Ctrl+Enter`の送信（Issue #2152の4）。フォーカスのある要素を囲むフォーム・ダイアログの
 * 送信ボタン（`data-submit`、無ければ`.btn.primary`）を押す。押せたらtrue。
 */
export function submitAround(target: EventTarget | null): boolean {
  // フォーカスがフォームの外（一覧など）なら何もしない。詳細の承認ボタンを誤って押さないように
  const from = target instanceof HTMLElement ? target : null;
  const scope = from?.closest<HTMLElement>('[data-submit-scope], form, [role="dialog"]');
  if (scope === null || scope === undefined) {
    return false;
  }
  if (scope instanceof HTMLFormElement) {
    scope.requestSubmit();
    return true;
  }
  const button =
    scope.querySelector<HTMLElement>('[data-submit]:not(:disabled)') ??
    scope.querySelector<HTMLElement>('.btn.primary:not(:disabled)');
  if (button === null) {
    return false;
  }
  button.click();
  return true;
}

/**
 * ダイアログの中でTabを回す（外の画面へフォーカスが抜けないように）。回したらtrue。
 * ダイアログの中で端に居ないときは標準のTabに任せる（falseを返す）。
 */
export function trapTab(dialog: HTMLElement, backward: boolean): boolean {
  const focusables = [
    ...dialog.querySelectorAll<HTMLElement>(`${ACTIONABLE}, [tabindex]:not([tabindex="-1"])`),
  ].filter((element) => (element as HTMLButtonElement).disabled !== true);
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (first === undefined || last === undefined) {
    return true;
  }
  const active = document.activeElement;
  const inside = active instanceof HTMLElement && dialog.contains(active);
  if (!inside || (backward && active === first)) {
    (backward ? last : first).focus();
    return true;
  }
  if (!backward && active === last) {
    first.focus();
    return true;
  }
  return false;
}
