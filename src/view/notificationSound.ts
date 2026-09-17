/**
 * 会話が停止したとき・応答待ちで止まったとき・自動引き継ぎが起きたときに鳴らす音
 * （issue #1242、issue #1246）。
 *
 * 実際の再生（コマンドの選定と起動）は`src/util/soundPlayback.ts`が担う。ここは
 * 設定（`agent.notifications.sound.*`）と同梱音源のパス解決という、`vscode`が要る部分だけを
 * 引き受ける薄い層。
 *
 * 同梱音源は`resources/`に置いてある（WAV / PCM 16bit / 44.1kHz）。`.vscodeignore`は
 * `resources/`を除外していないため、vsixにそのまま入る。
 */

import * as vscode from 'vscode';
import { readNotificationSoundConfig } from '../config';
import type { Logger } from '../log';
import { resolvePlayCommand, spawnPlayCommand } from '../util/soundPlayback';

/** 鳴らす場面。音を分けているのは、画面を見ずに何が起きたかを聞き分けるため。 */
export type NotificationSoundKind = 'turnComplete' | 'approvalPending' | 'handoff';

/** 同梱音源のファイル名。`resources/`直下に置く。 */
const BUNDLED_SOUND_FILES: Record<NotificationSoundKind, string> = {
  // 短い（0.37秒）。頻度が高いターン完了に割り当てる
  turnComplete: 'se_sac03.wav',
  // 長め（1.00秒）。対応が要る承認待ち・質問に割り当てる
  approvalPending: 'se_sab03.wav',
  // 中くらい（0.45秒）。自動引き継ぎでタブが切り替わったことを知らせる（Issue #1246）
  handoff: 'se_sad03.wav',
};

let extensionUri: vscode.Uri | undefined;
let logger: Logger | undefined;
/** 「鳴らせない」を毎回ログへ出さないための記録。理由ごとに1回だけ残す。 */
const warnedReasons = new Set<string>();

/**
 * `activate`から一度だけ呼ぶ。音源の置き場（拡張機能のインストール先）を覚える。
 *
 * これを呼ぶ前に`playNotificationSound`が呼ばれた場合、音は鳴らさず黙って戻る
 * （起動直後にターンが完了することは無く、実害が無いため）。
 */
export function initNotificationSounds(uri: vscode.Uri, log: Logger): void {
  extensionUri = uri;
  logger = log;
  warnedReasons.clear();
}

/** テスト・再初期化用。覚えた状態を捨てる。 */
export function resetNotificationSounds(): void {
  extensionUri = undefined;
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
 * 音を鳴らす。鳴らせない理由があっても例外は投げない。
 *
 * @param kind 鳴らす場面
 * @param panelVisible そのタブが今見えているか。`onlyWhenHidden`が有効なときだけ効く
 */
export function playNotificationSound(kind: NotificationSoundKind, panelVisible: boolean): void {
  const config = readNotificationSoundConfig();
  if (!config.enabled) {
    return;
  }
  if (kind === 'turnComplete' && !config.turnComplete) {
    return;
  }
  if (kind === 'approvalPending' && !config.approvalPending) {
    return;
  }
  if (kind === 'handoff' && !config.handoff) {
    return;
  }
  if (config.onlyWhenHidden && panelVisible) {
    return;
  }

  const overrides: Record<NotificationSoundKind, string> = {
    turnComplete: config.turnCompleteFile,
    approvalPending: config.approvalPendingFile,
    handoff: config.handoffFile,
  };
  const override = overrides[kind].trim();
  const file = override !== '' ? override : bundledSoundPath(kind);
  if (file === undefined) {
    return;
  }

  const resolved = resolvePlayCommand({ file, template: config.playerCommand });
  if (resolved === undefined) {
    warnOnce(
      'no-player',
      '通知音を鳴らせる再生コマンドが見つかりませんでした' +
        '（Linuxは paplay / pw-play / aplay / ffplay、macOSは afplay、Windowsは powershell.exe を探します）。' +
        '`agent.notifications.sound.playerCommand` で明示するか、`agent.notifications.sound.enabled` を false にしてください。',
    );
    return;
  }
  spawnPlayCommand(resolved, (message) => {
    warnOnce(
      `spawn:${resolved.command}`,
      `通知音を再生できませんでした（${resolved.command}）: ${message}`,
    );
  });
}

/** 同梱音源の実パス。`initNotificationSounds`前なら`undefined`。 */
function bundledSoundPath(kind: NotificationSoundKind): string | undefined {
  if (extensionUri === undefined) {
    return undefined;
  }
  return vscode.Uri.joinPath(extensionUri, 'resources', BUNDLED_SOUND_FILES[kind]).fsPath;
}
