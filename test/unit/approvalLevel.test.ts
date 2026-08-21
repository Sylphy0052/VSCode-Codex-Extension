import { describe, expect, it } from 'vitest';
import { APPROVAL_MODES, SANDBOX_MODES } from '../../src/codex/types';
import { CLAUDE_PERMISSION_MODES } from '../../src/claude/types';
import {
  APPROVAL_LEVELS,
  APPROVAL_LEVEL_CYCLE,
  approvalLevelMeta,
  claudePermissionModeForLevel,
  codexSettingsForLevel,
  describeLevel,
  isApprovalLevel,
  isUnsafeLevel,
  levelFromClaudePermissionMode,
  levelFromCodexSettings,
  nextApprovalLevel,
} from '../../src/provider/approvalLevel';
import { CLAUDE_PERMISSION_SAFETY_ORDER } from '../../src/util/safetyClamp';

describe('承認レベルの語彙', () => {
  it('3段階を安全順に並べている', () => {
    expect(APPROVAL_LEVELS).toEqual(['ask', 'auto', 'full']);
  });

  it('isApprovalLevelは語彙の値だけを通す', () => {
    expect(isApprovalLevel('auto')).toBe(true);
    expect(isApprovalLevel('never')).toBe(false);
    expect(isApprovalLevel('')).toBe(false);
    expect(isApprovalLevel(undefined)).toBe(false);
  });

  it('保護を全て外した状態はfullだけ', () => {
    expect(APPROVAL_LEVELS.filter((l) => isUnsafeLevel(l))).toEqual(['full']);
  });
});

describe('Codexの設定値への展開', () => {
  it('全確認は untrusted + workspace-write（承認要求は人へ回す）', () => {
    expect(codexSettingsForLevel('ask')).toEqual({
      approvalMode: 'untrusted',
      sandbox: 'workspace-write',
      approvalsReviewer: 'user',
    });
  });

  it('Autoは on-request + workspace-write + auto_review', () => {
    expect(codexSettingsForLevel('auto')).toEqual({
      approvalMode: 'on-request',
      sandbox: 'workspace-write',
      approvalsReviewer: 'auto_review',
    });
  });

  it('全承認は never + danger-full-access（docs/approval-modes.mdの対応表どおり）', () => {
    expect(codexSettingsForLevel('full')).toEqual({
      approvalMode: 'never',
      sandbox: 'danger-full-access',
      approvalsReviewer: 'user',
    });
  });

  it('展開先はCLIが受け付ける値の範囲に収まっている', () => {
    for (const level of APPROVAL_LEVELS) {
      const s = codexSettingsForLevel(level);
      expect(APPROVAL_MODES).toContain(s.approvalMode);
      expect(SANDBOX_MODES).toContain(s.sandbox);
    }
  });

  it('レベルが上がるほど緩い（生の値の安全順序と矛盾しない）', () => {
    const approvalRanks = APPROVAL_LEVELS.map((l) =>
      APPROVAL_MODES.indexOf(codexSettingsForLevel(l).approvalMode as never),
    );
    const sandboxRanks = APPROVAL_LEVELS.map((l) =>
      SANDBOX_MODES.indexOf(codexSettingsForLevel(l).sandbox as never),
    );
    expect(approvalRanks).toEqual([...approvalRanks].sort((a, b) => a - b));
    expect(sandboxRanks).toEqual([...sandboxRanks].sort((a, b) => a - b));
  });
});

describe('Claude Codeのpermission modeへの展開', () => {
  it('全確認/Auto/全承認が manual / auto / bypassPermissions に対応する', () => {
    expect(claudePermissionModeForLevel('ask')).toBe('manual');
    expect(claudePermissionModeForLevel('auto')).toBe('auto');
    expect(claudePermissionModeForLevel('full')).toBe('bypassPermissions');
  });

  it('展開先はCLIが受け付ける値の範囲に収まっている', () => {
    for (const level of APPROVAL_LEVELS) {
      expect(CLAUDE_PERMISSION_MODES).toContain(claudePermissionModeForLevel(level) as never);
    }
  });

  it('レベルが上がるほど緩い（CLAUDE_PERMISSION_SAFETY_ORDERと矛盾しない）', () => {
    const ranks = APPROVAL_LEVELS.map((l) =>
      CLAUDE_PERMISSION_SAFETY_ORDER.indexOf(claudePermissionModeForLevel(l)),
    );
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});

describe('現在の設定からレベルを引く', () => {
  it('3項目が揃って一致したときだけレベルを返す', () => {
    for (const level of APPROVAL_LEVELS) {
      expect(levelFromCodexSettings(codexSettingsForLevel(level))).toBe(level);
    }
  });

  it('approvalsReviewerの空文字はCodex側の既定（user）として扱う', () => {
    expect(
      levelFromCodexSettings({
        approvalMode: 'untrusted',
        sandbox: 'workspace-write',
        approvalsReviewer: '',
      }),
    ).toBe('ask');
  });

  it('1項目でもずれていればカスタム（undefined）', () => {
    // Autoの承認方針のまま、承認要求は人へ回している状態
    expect(
      levelFromCodexSettings({
        approvalMode: 'on-request',
        sandbox: 'workspace-write',
        approvalsReviewer: 'user',
      }),
    ).toBeUndefined();
    // サンドボックスだけ読み取り専用
    expect(
      levelFromCodexSettings({
        approvalMode: 'untrusted',
        sandbox: 'read-only',
        approvalsReviewer: 'user',
      }),
    ).toBeUndefined();
  });

  it('CLIへ委譲している（空文字の）設定はどのレベルにも一致させない', () => {
    expect(
      levelFromCodexSettings({ approvalMode: '', sandbox: '', approvalsReviewer: '' }),
    ).toBeUndefined();
  });

  it('Claudeはレベルに対応しないpermission modeでカスタムになる', () => {
    expect(levelFromClaudePermissionMode('manual')).toBe('ask');
    expect(levelFromClaudePermissionMode('bypassPermissions')).toBe('full');
    for (const mode of ['acceptEdits', 'plan', 'dontAsk', '']) {
      expect(levelFromClaudePermissionMode(mode)).toBeUndefined();
    }
  });
});

describe('Shift+Tabの循環', () => {
  it('全承認は循環に含めない（連打で保護が外れない）', () => {
    expect(APPROVAL_LEVEL_CYCLE).toEqual(['ask', 'auto']);
    expect(APPROVAL_LEVEL_CYCLE).not.toContain('full');
  });

  it('制限が強い側から緩い側へ進み、末尾から先頭へ戻る', () => {
    expect(nextApprovalLevel('ask')).toBe('auto');
    expect(nextApprovalLevel('auto')).toBe('ask');
  });

  it('循環外（カスタム・全承認）からはいちばん厳しいところへ寄せる', () => {
    expect(nextApprovalLevel(undefined)).toBe('ask');
    expect(nextApprovalLevel('full')).toBe('ask');
  });
});

describe('Webviewへ渡す表示情報', () => {
  it('全レベル分の表示名・説明・プロバイダごとの実効値を持つ', () => {
    const meta = approvalLevelMeta();
    expect(Object.keys(meta)).toEqual([...APPROVAL_LEVELS]);
    for (const level of APPROVAL_LEVELS) {
      expect(meta[level].label).not.toBe('');
      expect(meta[level].description).not.toBe('');
      expect(meta[level].effective.codex).toBe(describeLevel('codex', level));
      expect(meta[level].effective.claude).toBe(describeLevel('claude', level));
    }
  });

  it('JSONとして注入できる（webviewのスクリプトを壊さない）', () => {
    const json = JSON.stringify(approvalLevelMeta());
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json).not.toContain('</script>');
  });

  it('Codexの実効値は2軸、Claudeは1軸で説明する', () => {
    expect(describeLevel('codex', 'auto')).toBe('on-request / workspace-write / 自動レビュー');
    expect(describeLevel('claude', 'auto')).toBe('permission-mode: auto');
  });
});
