import { beforeEach, describe, expect, it } from 'vitest';
import {
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
