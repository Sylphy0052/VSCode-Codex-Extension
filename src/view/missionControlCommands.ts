import {
  MC_EXTENSION_COMMANDS,
  type McExtensionCommand,
} from '../webview/missionControl/extensionCommands';
import type { McProvider, McTarget } from '../webview/missionControl/protocol';

/** 許可リストのコマンド（idとの完全一致で引く。`Map`なので`__proto__`などは当たらない）。 */
const ALLOWED: ReadonlyMap<string, McExtensionCommand> = new Map(
  MC_EXTENSION_COMMANDS.map((command) => [command.id, command]),
);

/** `runCommand`で受け付けるキー。これ以外のキーが1つでもあれば拒む。 */
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'type',
  'seq',
  'command',
  'windowId',
  'provider',
  'threadId',
]);
const TARGET_KEYS = ['windowId', 'provider', 'threadId'] as const;

/** 実行してよいと確かめたコマンドと、拡張ホストが決めた引数。 */
export interface McRunCommandRequest {
  id: string;
  args: readonly unknown[];
}

/**
 * webviewから届いた`runCommand`を確かめる（Issue #2161）。実行してよければidと引数を、
 * だめなら理由の文を返す。
 *
 * - キーは`type`・`seq`・`command`と宛先の3つだけ。余分なキーがあれば拒む
 * - `command`は許可リストのidと完全一致する文字列だけを受ける
 * - 宛先は3つそろって渡されたときだけ見る。`isKnownSession`で拡張ホストが知っている
 *   セッションかを確かめ、引数にはそのセッションのproviderだけを使う
 * - 引数を取らないコマンドに宛先が付いていたら拒む
 */
export function parseRunCommand(
  message: Record<string, unknown>,
  isKnownSession: (target: McTarget) => boolean,
): McRunCommandRequest | string {
  if (
    Object.getPrototypeOf(message) !== Object.prototype &&
    Object.getPrototypeOf(message) !== null
  ) {
    return 'コマンドの形が正しくありません';
  }
  for (const key of Reflect.ownKeys(message)) {
    if (typeof key !== 'string' || !ALLOWED_KEYS.has(key)) {
      return 'コマンドの形が正しくありません';
    }
  }
  const id = message.command;
  if (typeof id !== 'string') {
    return 'コマンドが正しくありません';
  }
  const command = ALLOWED.get(id);
  if (command === undefined) {
    return 'このコマンドはMission Controlから実行できません';
  }
  const present = TARGET_KEYS.filter((key) => Object.hasOwn(message, key));
  if (present.length === 0) {
    return { id: command.id, args: [] };
  }
  if (command.arg === 'none') {
    return 'このコマンドは引数を取りません';
  }
  const target = toTarget(message);
  if (target === undefined || !isKnownSession(target)) {
    return '選択中のセッションが見つかりません';
  }
  return { id: command.id, args: [target.provider] };
}

function toTarget(message: Record<string, unknown>): McTarget | undefined {
  const { windowId, provider, threadId } = message;
  if (
    typeof windowId !== 'string' ||
    windowId === '' ||
    typeof threadId !== 'string' ||
    threadId === '' ||
    !isProvider(provider)
  ) {
    return undefined;
  }
  return { windowId, provider, threadId };
}

function isProvider(value: unknown): value is McProvider {
  return value === 'codex' || value === 'claude';
}
