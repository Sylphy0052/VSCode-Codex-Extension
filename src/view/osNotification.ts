/**
 * 会話が停止したとき・応答待ちで止まったとき・自動引き継ぎが起きたときに出すOS通知
 * （Issue #1285）。
 *
 * 実際の起動（WSL判定とPowerShellの実行）は`src/util/osNotify.ts`が担う。ここは設定
 * （`agent.notifications.os.*`）と文面の組み立てという、`vscode`が要る部分だけを
 * 引き受ける薄い層。通知音（`notificationSound.ts`）と同じ層分けにしてある。
 */

import * as vscode from 'vscode';
import { readOsNotificationConfig } from '../config';
import type { Logger } from '../log';
import {
  buildFocusUri,
  canShowOsNotification,
  foldForToast,
  showOsNotificationProcess,
} from '../util/osNotify';

/** 通知を出す場面。通知音の`NotificationSoundKind`と同じ顔ぶれ。 */
export type OsNotificationKind = 'turnComplete' | 'approvalPending' | 'handoff';

/** どちらのCLIの会話か。クリック先URIに載せ、開き直す側の管理クラスを選ぶのに使う。 */
export type OsNotificationProvider = 'codex' | 'claude';

/** 1件分の材料。 */
export interface OsNotificationInput {
  kind: OsNotificationKind;
  /** そのタブが今見えているか。`onlyWhenHidden`が有効なときだけ効く。 */
  panelVisible: boolean;
  /** 会話の名前。トーストの1行目に出る。 */
  sessionTitle: string;
  /** 会話のid（`threadId` / `sessionId`）。クリックで開き直す対象。空なら押せるボタンを付けない。 */
  threadId: string | undefined;
  provider: OsNotificationProvider;
  /** 2行目へ足す補足（承認の名前など）。省略可。 */
  detail?: string | undefined;
}

/** 場面ごとの本文。何が起きたかを見出しだけで分かるようにする。 */
const BODY: Record<OsNotificationKind, string> = {
  turnComplete: '応答が終わりました',
  approvalPending: '承認待ちです',
  handoff: '自動引き継ぎでタブが切り替わりました',
};

let extensionId: string | undefined;
let logger: Logger | undefined;
/** 「出せない」を毎回ログへ出さないための記録。理由ごとに1回だけ残す。 */
const warnedReasons = new Set<string>();

/**
 * `activate`から一度だけ呼ぶ。クリック先URIの組み立てに拡張機能のidが要る。
 *
 * これを呼ぶ前に`showOsNotification`が呼ばれた場合、通知は出るがクリックできない
 * （起動直後にターンが完了することは無く、実害が無いため）。
 */
export function initOsNotifications(id: string, log: Logger): void {
  extensionId = id;
  logger = log;
  warnedReasons.clear();
}

/** テスト・再初期化用。覚えた状態を捨てる。 */
export function resetOsNotifications(): void {
  extensionId = undefined;
  logger = undefined;
  warnedReasons.clear();
}

function warnOnce(key: string, message: string): void {
  if (warnedReasons.has(key)) {
    return;
  }
  warnedReasons.add(key);
  logger?.warn(message);
}

/**
 * OS通知を出す。出せない理由があっても例外は投げない。
 *
 * 設定が無効な間は`canShowOsNotification`も呼ばない（`powershell.exe`をPATHから探す
 * ファイルアクセスすら起こさない）。
 */
export function showOsNotification(input: OsNotificationInput): void {
  const config = readOsNotificationConfig();
  if (!config.enabled) {
    return;
  }
  if (input.kind === 'turnComplete' && !config.turnComplete) {
    return;
  }
  if (input.kind === 'approvalPending' && !config.approvalPending) {
    return;
  }
  if (input.kind === 'handoff' && !config.handoff) {
    return;
  }
  if (config.onlyWhenHidden && input.panelVisible) {
    return;
  }
  if (!canShowOsNotification()) {
    warnOnce(
      'unsupported',
      'OS通知を出せる環境ではありませんでした' +
        '（WSLまたはWindowsで`powershell.exe`が使えることが条件です）。' +
        '`agent.notifications.os.enabled` を false にすると、この判定自体を行いません。',
    );
    return;
  }

  const detail = input.detail === undefined ? '' : foldForToast(input.detail);
  const body = detail === '' ? BODY[input.kind] : `${BODY[input.kind]}（${detail}）`;
  void showOsNotificationProcess({
    title: foldForToast(input.sessionTitle),
    body: foldForToast(body),
    activationUri:
      extensionId === undefined
        ? ''
        : buildFocusUri({
            scheme: vscode.env.uriScheme,
            extensionId,
            provider: input.provider,
            threadId: input.threadId,
          }),
  }).then((outcome) => {
    if (outcome === 'failed') {
      warnOnce('failed', 'OS通知を出せませんでした（powershell.exeの起動に失敗しました）。');
      return;
    }
    if (outcome === 'fallback') {
      warnOnce(
        'fallback',
        'OS通知をクリックできない形で出しました（BurntToastが見つかりませんでした）。' +
          'クリックでVSCodeを最前面に出すには、Windows側で ' +
          '`Install-Module BurntToast -Scope CurrentUser` を実行してください。',
      );
    }
  });
}
