import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetPseudoWorktreeExcludeWarningForTestOnly,
  readChatComposerButtonsConfig,
  readChatSendOnConfig,
  readClaudeConfig,
  readNotificationsConfig,
  readWorkflowsConfig,
} from '../../src/config';
import { DEFAULT_COMPOSER_BUTTONS } from '../../src/view/composerButtons';
import { __mock } from '../mocks/vscode';

describe('readWorkflowsConfig（レビュー指摘: warning）', () => {
  beforeEach(() => {
    __mock.reset();
    // lastPseudoWorktreeExcludeWarningはモジュールスコープのため__mock.reset()では
    // リセットされない。放置すると同じ不正値を検証するテスト同士が実行順に依存する
    // （レビュー指摘1）。
    __resetPseudoWorktreeExcludeWarningForTestOnly();
  });

  it('既定値は .agents/workflows', () => {
    expect(readWorkflowsConfig().dir).toBe('.agents/workflows');
  });

  it('通常の相対パスはそのまま使う', () => {
    __mock.setConfig('agent', { 'workflows.dir': 'workflows' });
    expect(readWorkflowsConfig().dir).toBe('workflows');
  });

  it('..を含む値はワークスペース外を候補に混ぜられるため既定値へ落とす', () => {
    __mock.setConfig('agent', { 'workflows.dir': '../../outside' });
    expect(readWorkflowsConfig().dir).toBe('.agents/workflows');
  });

  it('絶対パスも既定値へ落とす', () => {
    __mock.setConfig('agent', { 'workflows.dir': '/etc/evil' });
    expect(readWorkflowsConfig().dir).toBe('.agents/workflows');
  });

  it('途中に..を含む値も既定値へ落とす（前方一致だけでなくセグメント単位で見る）', () => {
    __mock.setConfig('agent', { 'workflows.dir': 'a/../../b' });
    expect(readWorkflowsConfig().dir).toBe('.agents/workflows');
  });

  it('allowAutoApproveの既定はfalse', () => {
    expect(readWorkflowsConfig().allowAutoApprove).toBe(false);
  });

  it('roadmapDirの既定は docs/roadmap', () => {
    expect(readWorkflowsConfig().roadmapDir).toBe('docs/roadmap');
  });

  it('roadmapDirは通常の相対パスをそのまま使う', () => {
    __mock.setConfig('agent', { 'workflows.roadmapDir': 'roadmaps' });
    expect(readWorkflowsConfig().roadmapDir).toBe('roadmaps');
  });

  it('roadmapDirの..を含む値・絶対パスは既定値へ落とす', () => {
    __mock.setConfig('agent', { 'workflows.roadmapDir': '../../outside' });
    expect(readWorkflowsConfig().roadmapDir).toBe('docs/roadmap');

    __mock.setConfig('agent', { 'workflows.roadmapDir': '/etc/evil' });
    expect(readWorkflowsConfig().roadmapDir).toBe('docs/roadmap');
  });

  it('pseudoWorktreeExcludeの既定はnode_modules/.venv/dist/out（design.md §16.20）', () => {
    expect(readWorkflowsConfig().pseudoWorktreeExclude).toEqual([
      'node_modules',
      '.venv',
      'dist',
      'out',
    ]);
  });

  it('pseudoWorktreeExcludeは文字列配列をそのまま使う', () => {
    __mock.setConfig('agent', { 'workflows.pseudoWorktreeExclude': ['build', 'coverage'] });
    expect(readWorkflowsConfig().pseudoWorktreeExclude).toEqual(['build', 'coverage']);
  });

  const DEFAULT_EXCLUDE = ['node_modules', '.venv', 'dist', 'out'];

  it('pseudoWorktreeExcludeに.gitを含む値があれば設定全体を既定値へ落とす（Issue #446）', () => {
    __mock.setConfig('agent', { 'workflows.pseudoWorktreeExclude': ['node_modules', '.git'] });
    expect(readWorkflowsConfig().pseudoWorktreeExclude).toEqual(DEFAULT_EXCLUDE);
  });

  it('pseudoWorktreeExcludeの.GIT等の亜種も拒否する（大文字小文字を区別しない）', () => {
    __mock.setConfig('agent', { 'workflows.pseudoWorktreeExclude': ['.GIT'] });
    expect(readWorkflowsConfig().pseudoWorktreeExclude).toEqual(DEFAULT_EXCLUDE);

    __mock.setConfig('agent', { 'workflows.pseudoWorktreeExclude': ['.Git'] });
    expect(readWorkflowsConfig().pseudoWorktreeExclude).toEqual(DEFAULT_EXCLUDE);
  });

  it('pseudoWorktreeExcludeはパス区切りを含む値・絶対パスを拒否する', () => {
    __mock.setConfig('agent', { 'workflows.pseudoWorktreeExclude': ['packages/build'] });
    expect(readWorkflowsConfig().pseudoWorktreeExclude).toEqual(DEFAULT_EXCLUDE);

    __mock.setConfig('agent', { 'workflows.pseudoWorktreeExclude': ['packages\\build'] });
    expect(readWorkflowsConfig().pseudoWorktreeExclude).toEqual(DEFAULT_EXCLUDE);

    __mock.setConfig('agent', { 'workflows.pseudoWorktreeExclude': ['/etc'] });
    expect(readWorkflowsConfig().pseudoWorktreeExclude).toEqual(DEFAULT_EXCLUDE);
  });

  it('pseudoWorktreeExcludeを拒否したことは警告として人に見える形で出す（Issue #380の教訓）', () => {
    __mock.setConfig('agent', { 'workflows.pseudoWorktreeExclude': ['.git'] });
    const config = readWorkflowsConfig();
    expect(config.pseudoWorktreeExcludeWarnings).toHaveLength(1);
    expect(config.pseudoWorktreeExcludeWarnings[0]).toContain('.git');
    expect(config.pseudoWorktreeExcludeWarnings[0]).toContain(
      'agent.workflows.pseudoWorktreeExclude',
    );
    expect(__mock.messages.warnings).toHaveLength(1);
    expect(__mock.messages.warnings[0]).toContain('.git');
  });

  it('pseudoWorktreeExcludeの警告は同じ値を読み直しても重ねて通知しない', () => {
    __mock.setConfig('agent', { 'workflows.pseudoWorktreeExclude': ['dup-check/.git'] });
    readWorkflowsConfig();
    readWorkflowsConfig();
    expect(__mock.messages.warnings).toHaveLength(1);
  });

  it('pseudoWorktreeExcludeの既定値・正当な値は警告なしで通る', () => {
    expect(readWorkflowsConfig().pseudoWorktreeExcludeWarnings).toEqual([]);

    __mock.setConfig('agent', { 'workflows.pseudoWorktreeExclude': DEFAULT_EXCLUDE });
    expect(readWorkflowsConfig().pseudoWorktreeExcludeWarnings).toEqual([]);
    expect(readWorkflowsConfig().pseudoWorktreeExclude).toEqual(DEFAULT_EXCLUDE);

    __mock.setConfig('agent', {
      'workflows.pseudoWorktreeExclude': ['build', 'coverage', '.mypy_cache'],
    });
    expect(readWorkflowsConfig().pseudoWorktreeExclude).toEqual([
      'build',
      'coverage',
      '.mypy_cache',
    ]);
    expect(__mock.messages.warnings).toEqual([]);
  });

  it('pseudoWorktreeExcludeが配列でない・空文字要素を含む・空配列なら既定値へ落とす', () => {
    __mock.setConfig('agent', { 'workflows.pseudoWorktreeExclude': 'not-an-array' });
    expect(readWorkflowsConfig().pseudoWorktreeExclude).toEqual([
      'node_modules',
      '.venv',
      'dist',
      'out',
    ]);

    __mock.setConfig('agent', { 'workflows.pseudoWorktreeExclude': ['ok', ''] });
    expect(readWorkflowsConfig().pseudoWorktreeExclude).toEqual([
      'node_modules',
      '.venv',
      'dist',
      'out',
    ]);

    __mock.setConfig('agent', { 'workflows.pseudoWorktreeExclude': [] });
    expect(readWorkflowsConfig().pseudoWorktreeExclude).toEqual([
      'node_modules',
      '.venv',
      'dist',
      'out',
    ]);
  });

  // レビュー指摘1: 重複除け用のモジュール状態（lastPseudoWorktreeExcludeWarning）が
  // テスト間でリセットされないと、同じ不正値を検証する2つ目のテストで警告が0件になり
  // 落ちる。この2件を連続で並べて実行順に依存しないことを確認する。
  it('pseudoWorktreeExcludeの警告は同じ不正値を検証する別テスト1件目でも出る（レビュー指摘1・順序依存の再現）', () => {
    __mock.setConfig('agent', { 'workflows.pseudoWorktreeExclude': ['.git'] });
    readWorkflowsConfig();
    expect(__mock.messages.warnings).toHaveLength(1);
  });

  it('pseudoWorktreeExcludeの警告は同じ不正値を検証する別テスト2件目でも出る（レビュー指摘1・順序依存の再現）', () => {
    __mock.setConfig('agent', { 'workflows.pseudoWorktreeExclude': ['.git'] });
    readWorkflowsConfig();
    expect(__mock.messages.warnings).toHaveLength(1);
  });

  it('replyTimeoutSecの既定は300秒（design.md §16.21・DEFAULT_REPLY_TIMEOUT_SEC）', () => {
    expect(readWorkflowsConfig().replyTimeoutSec).toBe(300);
  });

  it('replyTimeoutSecは指定値をそのまま使う', () => {
    __mock.setConfig('agent', { 'workflows.replyTimeoutSec': 60 });
    expect(readWorkflowsConfig().replyTimeoutSec).toBe(60);
  });

  it('replyTimeoutSecが数値でない・1未満なら既定値へ落とす', () => {
    __mock.setConfig('agent', { 'workflows.replyTimeoutSec': 'たくさん' });
    expect(readWorkflowsConfig().replyTimeoutSec).toBe(300);

    __mock.setConfig('agent', { 'workflows.replyTimeoutSec': 0 });
    expect(readWorkflowsConfig().replyTimeoutSec).toBe(300);

    __mock.setConfig('agent', { 'workflows.replyTimeoutSec': -5 });
    expect(readWorkflowsConfig().replyTimeoutSec).toBe(300);
  });

  it('replyTimeoutSecの小数は切り捨てる', () => {
    __mock.setConfig('agent', { 'workflows.replyTimeoutSec': 60.7 });
    expect(readWorkflowsConfig().replyTimeoutSec).toBe(60);
  });

  it('branchNamingの既定はwf（GitLab運用規約形式は明示指定したときだけ有効になる）', () => {
    expect(readWorkflowsConfig().branchNaming).toBe('wf');
  });

  it('branchNamingはwf/conventionalをそのまま使う', () => {
    __mock.setConfig('agent', { 'workflows.branchNaming': 'conventional' });
    expect(readWorkflowsConfig().branchNaming).toBe('conventional');

    __mock.setConfig('agent', { 'workflows.branchNaming': 'wf' });
    expect(readWorkflowsConfig().branchNaming).toBe('wf');
  });

  it('branchNamingが未知の値なら既定値（wf）へ落とす', () => {
    __mock.setConfig('agent', { 'workflows.branchNaming': 'bogus' });
    expect(readWorkflowsConfig().branchNaming).toBe('wf');
  });

  it('draftPullRequestの既定はfalse（既存の「作成後すぐready」の挙動を変えない）', () => {
    expect(readWorkflowsConfig().draftPullRequest).toBe(false);
  });

  it('draftPullRequestはtrueを指定したとおりに使う', () => {
    __mock.setConfig('agent', { 'workflows.draftPullRequest': true });
    expect(readWorkflowsConfig().draftPullRequest).toBe(true);
  });

  it('draftPullRequestが未設定（undefined）なら既定値（false）へ落とす', () => {
    // 他の真偽値設定（allowAutoApprove等）と同じ `c.get<boolean>() ?? false` の形。
    // 値の型そのものの妥当性はpackage.jsonのJSON Schema（type: boolean）がVSCode側で
    // 担保する前提のため、ここでは「未設定→既定値」だけを見る
    __mock.setConfig('agent', {});
    expect(readWorkflowsConfig().draftPullRequest).toBe(false);
  });
});

describe('readClaudeConfig', () => {
  beforeEach(() => {
    __mock.reset();
  });

  it('agentの既定は空文字（--agentを渡さない）', () => {
    expect(readClaudeConfig().claude.agent).toBe('');
  });

  it('claude.agentを読む', () => {
    __mock.setConfig('claude', { agent: 'code-reviewer' });
    expect(readClaudeConfig().claude.agent).toBe('code-reviewer');
  });
});

describe('readChatSendOnConfig（issue #288）', () => {
  beforeEach(() => {
    __mock.reset();
  });

  it('既定はctrlEnter', () => {
    expect(readChatSendOnConfig()).toBe('ctrlEnter');
  });

  it('enterを読む', () => {
    __mock.setConfig('agent', { 'chat.sendOn': 'enter' });
    expect(readChatSendOnConfig()).toBe('enter');
  });

  it('未知の値は既定（ctrlEnter）へ丸める', () => {
    __mock.setConfig('agent', { 'chat.sendOn': 'always' });
    expect(readChatSendOnConfig()).toBe('ctrlEnter');
  });
});

describe('readChatComposerButtonsConfig（issue #296）', () => {
  beforeEach(() => {
    __mock.reset();
  });

  it('既定はDEFAULT_COMPOSER_BUTTONS（変更前の並びの先頭4つ）で、警告は無い', () => {
    const result = readChatComposerButtonsConfig();
    expect(result.buttons).toEqual(DEFAULT_COMPOSER_BUTTONS);
    expect(result.warning).toBeUndefined();
  });

  it('agent.chat.composerButtonsに既知のIDの配列を指定するとその順のまま使う', () => {
    __mock.setConfig('agent', { 'chat.composerButtons': ['review', 'workflowMenu'] });
    const result = readChatComposerButtonsConfig();
    expect(result.buttons).toEqual(['review', 'workflowMenu']);
    expect(result.warning).toBeUndefined();
  });

  it('未知のIDを含む場合は既定へ丸め、呼び出し側がログへ出せる警告を返す', () => {
    __mock.setConfig('agent', { 'chat.composerButtons': ['attach', 'nope'] });
    const result = readChatComposerButtonsConfig();
    expect(result.buttons).toEqual(DEFAULT_COMPOSER_BUTTONS);
    expect(result.warning).toContain('nope');
  });
});

describe('readNotificationsConfig（issue #286）', () => {
  beforeEach(() => {
    __mock.reset();
  });

  it('既定はapprovalPending: true・turnComplete: false', () => {
    expect(readNotificationsConfig()).toEqual({ approvalPending: true, turnComplete: false });
  });

  it('agent.notifications.approvalPendingをfalseにできる', () => {
    __mock.setConfig('agent', { 'notifications.approvalPending': false });
    expect(readNotificationsConfig().approvalPending).toBe(false);
  });

  it('agent.notifications.turnCompleteをtrueにできる', () => {
    __mock.setConfig('agent', { 'notifications.turnComplete': true });
    expect(readNotificationsConfig().turnComplete).toBe(true);
  });
});
