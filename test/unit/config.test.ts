import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetPseudoWorktreeExcludeWarningForTestOnly,
  readChatComposerButtonsConfig,
  readChatSendOnConfig,
  readChatTurnSummaryConfig,
  setChatTurnSummaryEnabled,
  readClaudeConfig,
  readNotificationsConfig,
  readWorkflowsConfig,
} from '../../src/config';
import { DEFAULT_COMPOSER_BUTTONS } from '../../src/view/composerButtons';
import { DEFAULT_TURN_SUMMARY_INSTRUCTION } from '../../src/view/turnSummary';
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

  // レビュー指摘2: 空判定にはtrimを使うのに、配列へ残すのはトリムしない生の値だった。
  // トリムしてから空判定・拒否判定・格納まで一貫させる。
  it('pseudoWorktreeExcludeは前後の空白をトリムしてから格納する（レビュー指摘2）', () => {
    __mock.setConfig('agent', { 'workflows.pseudoWorktreeExclude': [' build ', 'coverage'] });
    expect(readWorkflowsConfig().pseudoWorktreeExclude).toEqual(['build', 'coverage']);
  });

  it('pseudoWorktreeExcludeは前後に空白が付いた.gitも拒否する（レビュー指摘2）', () => {
    __mock.setConfig('agent', { 'workflows.pseudoWorktreeExclude': [' .git '] });
    expect(readWorkflowsConfig().pseudoWorktreeExclude).toEqual(DEFAULT_EXCLUDE);
  });

  // レビュー指摘3: isSafeRelativeDirは`..`セグメントを明示的に拒否するのに、
  // pseudoWorktreeExcludeRejectionには同じガードが無い（姉妹バリデーションの非対称）。
  it('pseudoWorktreeExcludeは..・.を拒否する（レビュー指摘3）', () => {
    __mock.setConfig('agent', { 'workflows.pseudoWorktreeExclude': ['..'] });
    expect(readWorkflowsConfig().pseudoWorktreeExclude).toEqual(DEFAULT_EXCLUDE);

    __mock.setConfig('agent', { 'workflows.pseudoWorktreeExclude': ['.'] });
    expect(readWorkflowsConfig().pseudoWorktreeExclude).toEqual(DEFAULT_EXCLUDE);
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

  it('replyTimeoutSecが上限（2147483秒）を超えたら既定値へ落とす（レビュー・監査指摘: setTimeoutの32bit丸めで即時発火する事故を防ぐ）', () => {
    __mock.setConfig('agent', { 'workflows.replyTimeoutSec': 2147484 });
    expect(readWorkflowsConfig().replyTimeoutSec).toBe(300);

    __mock.setConfig('agent', { 'workflows.replyTimeoutSec': 999999999 });
    expect(readWorkflowsConfig().replyTimeoutSec).toBe(300);
  });

  it('replyTimeoutSecは上限（2147483秒）ちょうどまでは指定値をそのまま使う', () => {
    __mock.setConfig('agent', { 'workflows.replyTimeoutSec': 2147483 });
    expect(readWorkflowsConfig().replyTimeoutSec).toBe(2147483);
  });

  it('mergeApprovalTimeoutSecの既定は3600秒（design.md §16.17・DEFAULT_MERGE_APPROVAL_TIMEOUT_SEC）', () => {
    expect(readWorkflowsConfig().mergeApprovalTimeoutSec).toBe(3600);
  });

  it('mergeApprovalTimeoutSecは指定値をそのまま使う', () => {
    __mock.setConfig('agent', { 'workflows.mergeApprovalTimeoutSec': 60 });
    expect(readWorkflowsConfig().mergeApprovalTimeoutSec).toBe(60);
  });

  it('mergeApprovalTimeoutSecが数値でない・1未満なら既定値へ落とす', () => {
    __mock.setConfig('agent', { 'workflows.mergeApprovalTimeoutSec': 'たくさん' });
    expect(readWorkflowsConfig().mergeApprovalTimeoutSec).toBe(3600);

    __mock.setConfig('agent', { 'workflows.mergeApprovalTimeoutSec': 0 });
    expect(readWorkflowsConfig().mergeApprovalTimeoutSec).toBe(3600);

    __mock.setConfig('agent', { 'workflows.mergeApprovalTimeoutSec': -5 });
    expect(readWorkflowsConfig().mergeApprovalTimeoutSec).toBe(3600);
  });

  it('mergeApprovalTimeoutSecの小数は切り捨てる', () => {
    __mock.setConfig('agent', { 'workflows.mergeApprovalTimeoutSec': 60.7 });
    expect(readWorkflowsConfig().mergeApprovalTimeoutSec).toBe(60);
  });

  it('mergeApprovalTimeoutSecが上限（2147483秒）を超えたら既定値へ落とす（レビュー・監査指摘: setTimeoutの32bit丸めで即時発火する事故を防ぐ）', () => {
    __mock.setConfig('agent', { 'workflows.mergeApprovalTimeoutSec': 2147484 });
    expect(readWorkflowsConfig().mergeApprovalTimeoutSec).toBe(3600);

    __mock.setConfig('agent', { 'workflows.mergeApprovalTimeoutSec': 999999999 });
    expect(readWorkflowsConfig().mergeApprovalTimeoutSec).toBe(3600);
  });

  it('mergeApprovalTimeoutSecは上限（2147483秒）ちょうどまでは指定値をそのまま使う', () => {
    __mock.setConfig('agent', { 'workflows.mergeApprovalTimeoutSec': 2147483 });
    expect(readWorkflowsConfig().mergeApprovalTimeoutSec).toBe(2147483);
  });

  it('taskApprovalTimeoutSecの既定は3600秒（design.md §16.39・DEFAULT_TASK_APPROVAL_TIMEOUT_SEC）', () => {
    expect(readWorkflowsConfig().taskApprovalTimeoutSec).toBe(3600);
  });

  it('taskApprovalTimeoutSecは指定値をそのまま使う', () => {
    __mock.setConfig('agent', { 'workflows.taskApprovalTimeoutSec': 60 });
    expect(readWorkflowsConfig().taskApprovalTimeoutSec).toBe(60);
  });

  it('taskApprovalTimeoutSecが数値でない・1未満・上限超過なら既定値へ落とす', () => {
    __mock.setConfig('agent', { 'workflows.taskApprovalTimeoutSec': 'たくさん' });
    expect(readWorkflowsConfig().taskApprovalTimeoutSec).toBe(3600);

    __mock.setConfig('agent', { 'workflows.taskApprovalTimeoutSec': 0 });
    expect(readWorkflowsConfig().taskApprovalTimeoutSec).toBe(3600);

    __mock.setConfig('agent', { 'workflows.taskApprovalTimeoutSec': 2147484 });
    expect(readWorkflowsConfig().taskApprovalTimeoutSec).toBe(3600);
  });

  it('mergeApprovalTimeoutSecとtaskApprovalTimeoutSecは互いに影響しない（design.md §16.17）', () => {
    __mock.setConfig('agent', {
      'workflows.mergeApprovalTimeoutSec': 60,
      'workflows.taskApprovalTimeoutSec': 120,
    });
    expect(readWorkflowsConfig().mergeApprovalTimeoutSec).toBe(60);
    expect(readWorkflowsConfig().taskApprovalTimeoutSec).toBe(120);
  });

  it('stallRepeatCountの既定は4回（design.md §16.27・DEFAULT_STALL_REPEAT_COUNT、Issue #336）', () => {
    expect(readWorkflowsConfig().stallRepeatCount).toBe(4);
  });

  it('stallRepeatCountは範囲内（2〜50）の指定値をそのまま使う', () => {
    __mock.setConfig('agent', { 'workflows.stallRepeatCount': 6 });
    expect(readWorkflowsConfig().stallRepeatCount).toBe(6);
  });

  it('stallRepeatCountが数値でない・2未満・50超過・非整数なら既定値（4）へ落とす', () => {
    __mock.setConfig('agent', { 'workflows.stallRepeatCount': 'たくさん' });
    expect(readWorkflowsConfig().stallRepeatCount).toBe(4);

    __mock.setConfig('agent', { 'workflows.stallRepeatCount': 1 });
    expect(readWorkflowsConfig().stallRepeatCount).toBe(4);

    __mock.setConfig('agent', { 'workflows.stallRepeatCount': 51 });
    expect(readWorkflowsConfig().stallRepeatCount).toBe(4);

    __mock.setConfig('agent', { 'workflows.stallRepeatCount': 3.5 });
    expect(readWorkflowsConfig().stallRepeatCount).toBe(4);
  });

  it('ciWaitTimeoutSecの既定は1800秒（design.md §16.36・DEFAULT_CI_WAIT_TIMEOUT_SEC）', () => {
    expect(readWorkflowsConfig().ciWaitTimeoutSec).toBe(1800);
  });

  it('ciWaitTimeoutSecは指定値をそのまま使う', () => {
    __mock.setConfig('agent', { 'workflows.ciWaitTimeoutSec': 60 });
    expect(readWorkflowsConfig().ciWaitTimeoutSec).toBe(60);
  });

  it('ciWaitTimeoutSecが数値でない・1未満・上限超過なら既定値へ落とす', () => {
    __mock.setConfig('agent', { 'workflows.ciWaitTimeoutSec': 'たくさん' });
    expect(readWorkflowsConfig().ciWaitTimeoutSec).toBe(1800);

    __mock.setConfig('agent', { 'workflows.ciWaitTimeoutSec': 0 });
    expect(readWorkflowsConfig().ciWaitTimeoutSec).toBe(1800);

    __mock.setConfig('agent', { 'workflows.ciWaitTimeoutSec': 2147484 });
    expect(readWorkflowsConfig().ciWaitTimeoutSec).toBe(1800);
  });

  it('ciUpdateBranchMaxRetriesの既定は2回（design.md §16.36・DEFAULT_CI_UPDATE_BRANCH_MAX_RETRIES）', () => {
    expect(readWorkflowsConfig().ciUpdateBranchMaxRetries).toBe(2);
  });

  it('ciUpdateBranchMaxRetriesは指定値をそのまま使う（0も有効な値として扱う）', () => {
    __mock.setConfig('agent', { 'workflows.ciUpdateBranchMaxRetries': 5 });
    expect(readWorkflowsConfig().ciUpdateBranchMaxRetries).toBe(5);

    __mock.setConfig('agent', { 'workflows.ciUpdateBranchMaxRetries': 0 });
    expect(readWorkflowsConfig().ciUpdateBranchMaxRetries).toBe(0);
  });

  it('ciUpdateBranchMaxRetriesが数値でない・負値・非整数・上限（100）超過なら既定値へ落とす', () => {
    __mock.setConfig('agent', { 'workflows.ciUpdateBranchMaxRetries': 'たくさん' });
    expect(readWorkflowsConfig().ciUpdateBranchMaxRetries).toBe(2);

    __mock.setConfig('agent', { 'workflows.ciUpdateBranchMaxRetries': -1 });
    expect(readWorkflowsConfig().ciUpdateBranchMaxRetries).toBe(2);

    __mock.setConfig('agent', { 'workflows.ciUpdateBranchMaxRetries': 1.5 });
    expect(readWorkflowsConfig().ciUpdateBranchMaxRetries).toBe(2);

    __mock.setConfig('agent', { 'workflows.ciUpdateBranchMaxRetries': 101 });
    expect(readWorkflowsConfig().ciUpdateBranchMaxRetries).toBe(2);
  });

  it('reviewCommentPollIntervalSecの既定は600秒（design.md §16.30・DEFAULT_REVIEW_COMMENT_POLL_INTERVAL_SEC、Issue #339）', () => {
    expect(readWorkflowsConfig().reviewCommentPollIntervalSec).toBe(600);
  });

  it('reviewCommentPollIntervalSecは指定値をそのまま使う（0も有効な値として扱う＝取得しない）', () => {
    __mock.setConfig('agent', { 'workflows.reviewCommentPollIntervalSec': 120 });
    expect(readWorkflowsConfig().reviewCommentPollIntervalSec).toBe(120);

    __mock.setConfig('agent', { 'workflows.reviewCommentPollIntervalSec': 0 });
    expect(readWorkflowsConfig().reviewCommentPollIntervalSec).toBe(0);
  });

  it('reviewCommentPollIntervalSecが数値でない・負値・非整数・上限超過なら既定値へ落とす', () => {
    __mock.setConfig('agent', { 'workflows.reviewCommentPollIntervalSec': 'たくさん' });
    expect(readWorkflowsConfig().reviewCommentPollIntervalSec).toBe(600);

    __mock.setConfig('agent', { 'workflows.reviewCommentPollIntervalSec': -1 });
    expect(readWorkflowsConfig().reviewCommentPollIntervalSec).toBe(600);

    __mock.setConfig('agent', { 'workflows.reviewCommentPollIntervalSec': 1.5 });
    expect(readWorkflowsConfig().reviewCommentPollIntervalSec).toBe(600);

    __mock.setConfig('agent', { 'workflows.reviewCommentPollIntervalSec': 2147484 });
    expect(readWorkflowsConfig().reviewCommentPollIntervalSec).toBe(600);
  });

  it('maxAskUserPerRunの既定は3回（design.md §16.33・DEFAULT_MAX_ASK_USER_PER_RUN、Issue #583）', () => {
    expect(readWorkflowsConfig().maxAskUserPerRun).toBe(3);
  });

  it('maxAskUserPerRunは範囲内（1〜20）の指定値をそのまま使う', () => {
    __mock.setConfig('agent', { 'workflows.maxAskUserPerRun': 1 });
    expect(readWorkflowsConfig().maxAskUserPerRun).toBe(1);

    __mock.setConfig('agent', { 'workflows.maxAskUserPerRun': 20 });
    expect(readWorkflowsConfig().maxAskUserPerRun).toBe(20);
  });

  it('maxAskUserPerRunが数値でない・1未満・20超過・非整数なら既定値（3）へ落とす', () => {
    __mock.setConfig('agent', { 'workflows.maxAskUserPerRun': 'たくさん' });
    expect(readWorkflowsConfig().maxAskUserPerRun).toBe(3);

    __mock.setConfig('agent', { 'workflows.maxAskUserPerRun': 0 });
    expect(readWorkflowsConfig().maxAskUserPerRun).toBe(3);

    __mock.setConfig('agent', { 'workflows.maxAskUserPerRun': 21 });
    expect(readWorkflowsConfig().maxAskUserPerRun).toBe(3);

    __mock.setConfig('agent', { 'workflows.maxAskUserPerRun': 2.5 });
    expect(readWorkflowsConfig().maxAskUserPerRun).toBe(3);
  });

  it('autoResumeの既定はtrue（design.md §16.35、roadmap W10、Issue #584）', () => {
    expect(readWorkflowsConfig().autoResume).toBe(true);
  });

  it('autoResumeはfalseを明示指定するとfalseになる', () => {
    __mock.setConfig('agent', { 'workflows.autoResume': false });
    expect(readWorkflowsConfig().autoResume).toBe(false);
  });

  it('maxAutoResumeAttemptsの既定は3回（design.md §16.35、roadmap W10、Issue #584）', () => {
    expect(readWorkflowsConfig().maxAutoResumeAttempts).toBe(3);
  });

  it('maxAutoResumeAttemptsは範囲内（1〜20）の指定値をそのまま使う', () => {
    __mock.setConfig('agent', { 'workflows.maxAutoResumeAttempts': 1 });
    expect(readWorkflowsConfig().maxAutoResumeAttempts).toBe(1);

    __mock.setConfig('agent', { 'workflows.maxAutoResumeAttempts': 20 });
    expect(readWorkflowsConfig().maxAutoResumeAttempts).toBe(20);
  });

  it('maxAutoResumeAttemptsが数値でない・1未満・20超過・非整数なら既定値（3）へ落とす', () => {
    __mock.setConfig('agent', { 'workflows.maxAutoResumeAttempts': 'たくさん' });
    expect(readWorkflowsConfig().maxAutoResumeAttempts).toBe(3);

    __mock.setConfig('agent', { 'workflows.maxAutoResumeAttempts': 0 });
    expect(readWorkflowsConfig().maxAutoResumeAttempts).toBe(3);

    __mock.setConfig('agent', { 'workflows.maxAutoResumeAttempts': 21 });
    expect(readWorkflowsConfig().maxAutoResumeAttempts).toBe(3);

    __mock.setConfig('agent', { 'workflows.maxAutoResumeAttempts': 2.5 });
    expect(readWorkflowsConfig().maxAutoResumeAttempts).toBe(3);
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

  it('createTaskIssueの既定はfalse（design.md §16.31、roadmap W6、Issue #596）', () => {
    expect(readWorkflowsConfig().createTaskIssue).toBe(false);
  });

  it('createTaskIssueはtrueを指定したとおりに使う', () => {
    __mock.setConfig('agent', { 'workflows.createTaskIssue': true });
    expect(readWorkflowsConfig().createTaskIssue).toBe(true);
  });

  it('createTaskIssueが未設定（undefined）なら既定値（false）へ落とす', () => {
    __mock.setConfig('agent', {});
    expect(readWorkflowsConfig().createTaskIssue).toBe(false);
  });

  it('reviewTaskPullRequestの既定はfalse（design.md §16.31、roadmap W6、Issue #596）', () => {
    expect(readWorkflowsConfig().reviewTaskPullRequest).toBe(false);
  });

  it('reviewTaskPullRequestはtrueを指定したとおりに使う', () => {
    __mock.setConfig('agent', { 'workflows.reviewTaskPullRequest': true });
    expect(readWorkflowsConfig().reviewTaskPullRequest).toBe(true);
  });

  it('reviewTaskPullRequestが未設定（undefined）なら既定値（false）へ落とす', () => {
    __mock.setConfig('agent', {});
    expect(readWorkflowsConfig().reviewTaskPullRequest).toBe(false);
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

describe('readChatTurnSummaryConfig（issue #709）', () => {
  beforeEach(() => {
    __mock.reset();
  });

  it('既定は無効で、指示文はDEFAULT_TURN_SUMMARY_INSTRUCTION', () => {
    expect(readChatTurnSummaryConfig()).toEqual({
      enabled: false,
      instruction: DEFAULT_TURN_SUMMARY_INSTRUCTION,
    });
  });

  it('agent.chat.turnSummary.enabledをtrueにできる', () => {
    __mock.setConfig('agent', { 'chat.turnSummary.enabled': true });
    expect(readChatTurnSummaryConfig().enabled).toBe(true);
  });

  it('ターン要約の有効無効をユーザー設定へ保存できる', async () => {
    await setChatTurnSummaryEnabled(true);
    expect(readChatTurnSummaryConfig().enabled).toBe(true);
    await setChatTurnSummaryEnabled(false);
    expect(readChatTurnSummaryConfig().enabled).toBe(false);
  });

  it('agent.chat.turnSummary.instructionを差し替えられる', () => {
    __mock.setConfig('agent', { 'chat.turnSummary.instruction': '要約も出して' });
    expect(readChatTurnSummaryConfig().instruction).toBe('要約も出して');
  });

  it('空文字の指示文はそのまま返す（連結側が無効化として扱う）', () => {
    __mock.setConfig('agent', { 'chat.turnSummary.instruction': '' });
    expect(readChatTurnSummaryConfig().instruction).toBe('');
  });

  it('文字列でない指示文は既定へ倒す', () => {
    __mock.setConfig('agent', { 'chat.turnSummary.instruction': 42 });
    expect(readChatTurnSummaryConfig().instruction).toBe(DEFAULT_TURN_SUMMARY_INSTRUCTION);
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
