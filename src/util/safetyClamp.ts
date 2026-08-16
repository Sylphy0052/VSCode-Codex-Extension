import { APPROVAL_MODES, SANDBOX_MODES } from '../codex/types';

/**
 * 権限を緩める方向の指定を拒む「クランプ」の実体（design.md §16.16）。
 *
 * 元は `src/orchestrator/workflow.ts`（ワークフローYAMLの `taskConfig`）専用に書かれた
 * ものだったが、issue #295のセッションプリセット（`src/sessionPresets.ts`）も同じ
 * 「拡張機能側の設定より緩めない」不変条件を必要としたため、`vscode` に依存しない
 * 中立な場所（`src/util`）へ抽出した（issue #308）。`src/orchestrator/taskConfig.ts` と
 * `src/sessionPresets.ts` の両方がここへ依存する形にし、ワークフロー実行専用の
 * `workflow.ts` へ機能領域の異なるモジュールが踏み込む向きを解消した。
 *
 * このファイルの移動は純粋な置き場所の変更であり、安全順序表の値・順序、
 * `clampToSafer` の判定ロジック（fail-closedの各分岐）は一切変えていない。
 */

/**
 * クランプの基準になる、拡張機能側の現在の設定値のうち`sandbox` / `approvalMode` /
 * `permissionMode`の3項目（design.md §16.16）。
 *
 * `taskConfig.ts`の`ExtensionSafetyBaseline`（`allowAutoApprove` /
 * `allowClaudeBypassPermissions`を追加で持つ）と`sessionPresets.ts`の
 * `PresetSafetyBaseline`はどちらもこの3項目をそのまま必要とするため、重複定義を避けて
 * ここを土台にする（issue #308）。`sessionPresets.ts`は`src/orchestrator/**`をimportしない
 * 制約があるため、`PresetSafetyBaseline`が`ExtensionSafetyBaseline`を直接参照する形は
 * 採れない。共通部分だけをこの中立な場所に置き、両方がここから拡張する形にした。
 */
export interface SafetyBaseline {
  /** `codex.sandbox`。空文字はCodex CLI側（config.toml）への委譲を意味する。 */
  codexSandbox: string;
  /** `codex.approvalMode`。 */
  codexApprovalMode: string;
  /** `claude.permissionMode`。 */
  claudePermissionMode: string;
}

/** クランプ関数の結果。`warning` は緩める指定を無視したときだけ入る。 */
export interface ClampResult {
  value: string;
  warning: string | undefined;
}

/**
 * `sandbox` の安全順序。左ほど安全（読み取り専用）、右ほど危険（無制限）。
 * `src/codex/types.ts` の `SANDBOX_MODES` は宣言順がそのまま安全順序になっているため、
 * 値をそのまま再利用する（値と順序を別々に持つと将来どちらかだけ変更されて乖離しうる）。
 */
export const SANDBOX_SAFETY_ORDER: readonly string[] = SANDBOX_MODES;

/**
 * Codexの `approvalMode` の安全順序。左ほど安全（毎回確認を挟む）、右ほど危険（無確認）。
 * `src/codex/types.ts` の `APPROVAL_MODES` は宣言順がそのまま安全順序になっているため、
 * 値をそのまま再利用する。
 */
export const CODEX_APPROVAL_SAFETY_ORDER: readonly string[] = APPROVAL_MODES;

/**
 * Claudeの `permissionMode` の安全順序。`src/claude/types.ts` の `CLAUDE_PERMISSION_MODES`
 * は語彙の列挙順であって安全順ではないため、ここで独自に定義する。
 *
 * 出典: Claude Code公式ドキュメント「Permission modes」の「Available modes」表
 * （https://code.claude.com/docs/en/permission-modes.md、確認日2026-08-10）。要点は次のとおり。
 *
 * | Mode（表内の呼称）                              | What runs without asking                                              |
 * | ------------------------------------------------ | ----------------------------------------------------------------------- |
 * | `default`（CLIの表示名はManual。`manual`はそのalias） | Reads only                                                          |
 * | `acceptEdits`                                     | Reads, file edits, and common filesystem commands（`mkdir` `touch` `mv` `cp` 等） |
 * | `plan`                                            | Reads, plus classifier-approved commands when auto mode is available   |
 * | `auto`                                            | Everything, with background safety checks                              |
 * | `dontAsk`                                         | Only pre-approved tools                                                |
 * | `bypassPermissions`                               | Everything                                                              |
 *
 * 同ページには「Writes to protected paths are never auto-approved except in
 * `bypassPermissions` mode and in planning sessions with bypass permissions available.」
 * ともある。
 *
 * **`dontAsk` はこの順序表に含めていない。** 「事前承認したツールだけ通す」という性質は、
 * 利用者が設定した `permissions.allow` の中身次第で安全にも危険にもなり、他のモードと
 * 一次元の安全順序では比較できない。仮に無理な位置（例えば `acceptEdits` と `auto` の間）へ
 * 割り当てると、拡張機能側が `dontAsk` を使っているときにYAML側の値を実際より「安全」と
 * 誤判定して通してしまう恐れがある。`clampToSafer` は順序表に無い値を「安全性を判定できない」
 * として拡張機能側の値をそのまま採用する（design.md §16.16）ため、`dontAsk` を順序表から
 * 除外しておくことでfail-closedになる。
 */
export const CLAUDE_PERMISSION_SAFETY_ORDER: readonly string[] = [
  'plan',
  'manual',
  'acceptEdits',
  'auto',
  'bypassPermissions',
];

/**
 * 拡張機能側の値より安全な方向にしか動かせないようにする（design.md §16.16）。
 *
 * 安全順序の中に無い値（拡張機能・YAMLのいずれか）は判定のしようがないため、
 * 緩められる側に倒さず拡張機能側の値を採用する……が、これには1つ抜け穴があった。
 * `extensionValue`が空文字（`codex.sandbox` / `codex.approvalMode` /
 * `claude.permissionMode`の既定値。CLI側の設定へ委譲する、の意）のとき、`order`の
 * どの値とも一致せず`extIndex === -1`になる。この場合に無条件で`extensionValue`
 * （＝空文字）を採用すると、YAML側が最も安全な値（`sandbox: read-only`等）を明示しても
 * 無視され、**空文字のまま`openTaskSession`へ渡ってCLI設定に丸投げされる**
 * （実効的にサンドボックスなし・確認なしになりうる。#58セキュリティ監査 critical）。
 *
 * `extIndex === -1`（baselineの安全性が不明）のときは、大小を比較できない代わりに
 * 「YAML側が安全順序の最安全値（`order[0]`）かどうか」だけで判定する。最安全値は
 * これ以上緩めようがない値なので、baselineが何であっても「緩める」ことは論理的に
 * ありえない。それ以外の値（baselineより緩いか安全か判定できない）は従来通り拒否する
 * （fail-closed）。YAML側が安全順序に無い値（`yamlIndex === -1`）のときは、baselineの
 * 状態に関わらず判定不能として拒否する。YAML側が空文字（未指定）ならそのまま
 * 拡張機能側を使う。
 */
export function clampToSafer(
  order: readonly string[],
  extensionValue: string,
  yamlValue: string,
): ClampResult {
  if (yamlValue === '') {
    return { value: extensionValue, warning: undefined };
  }
  const extIndex = order.indexOf(extensionValue);
  const yamlIndex = order.indexOf(yamlValue);
  if (yamlIndex === -1) {
    return {
      value: extensionValue,
      warning: `安全性を判定できない値のため無視しました: ${yamlValue}`,
    };
  }
  if (extIndex === -1) {
    if (yamlIndex === 0) {
      // 最安全値は、baselineがどんな値であっても「緩める」結果にはなりえない
      return { value: yamlValue, warning: undefined };
    }
    return {
      value: extensionValue,
      warning:
        `拡張機能の設定(${extensionValue === '' ? '既定（CLI側の設定に委譲）' : extensionValue})の` +
        `安全性を判定できないため、最も安全な値以外の指定は無視しました: ${yamlValue}`,
    };
  }
  if (yamlIndex <= extIndex) {
    return { value: yamlValue, warning: undefined };
  }
  return {
    value: extensionValue,
    warning: `拡張機能の設定より緩い指定は無視しました: ${yamlValue} → ${extensionValue}`,
  };
}

export function clampSandbox(extensionValue: string, yamlValue: string): ClampResult {
  return clampToSafer(SANDBOX_SAFETY_ORDER, extensionValue, yamlValue);
}

export function clampCodexApprovalMode(extensionValue: string, yamlValue: string): ClampResult {
  return clampToSafer(CODEX_APPROVAL_SAFETY_ORDER, extensionValue, yamlValue);
}

export function clampClaudePermissionMode(extensionValue: string, yamlValue: string): ClampResult {
  return clampToSafer(CLAUDE_PERMISSION_SAFETY_ORDER, extensionValue, yamlValue);
}
