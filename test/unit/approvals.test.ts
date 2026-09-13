import { describe, expect, it } from 'vitest';
import {
  APPROVAL_METHODS,
  buildApprovalResponse,
  defaultDenyResponse,
  describeApproval,
  SERVER_REQUEST_METHODS,
  summarizePermissions,
} from '../../src/appserver/approvals';

describe('describeApproval', () => {
  it('コマンド実行の要求をコマンドとcwd付きで表す', () => {
    const approval = describeApproval(1, APPROVAL_METHODS.command, {
      command: 'rm -rf build',
      cwd: '/work',
    });
    expect(approval).toMatchObject({ requestId: 1, kind: 'command' });
    expect(approval?.detail).toContain('rm -rf build');
    expect(approval?.detail).toContain('/work');
  });

  it('ファイル変更の要求は理由を出す', () => {
    const approval = describeApproval(2, APPROVAL_METHODS.fileChange, {
      itemId: 'f1',
      threadId: 't1',
      turnId: 'turn1',
      startedAtMs: 0,
      reason: '書き込み権限の要求',
    });
    expect(approval?.kind).toBe('fileChange');
    expect(approval?.detail).toBe('書き込み権限の要求');
  });

  it('ファイル変更の要求は itemId を持つ（差分は項目側から引くため）', () => {
    // FileChangeRequestApprovalParams は changes を持たない。差分は同じitemIdの項目にある
    const approval = describeApproval(2, APPROVAL_METHODS.fileChange, {
      itemId: 'f1',
      threadId: 't1',
      turnId: 'turn1',
      startedAtMs: 0,
    });
    expect(approval).toMatchObject({ kind: 'fileChange', itemId: 'f1' });
  });

  it('差分を項目から引けない要求では itemId を持たない', () => {
    expect(
      describeApproval(3, APPROVAL_METHODS.command, { command: 'ls' })?.itemId,
    ).toBeUndefined();
  });

  it('権限昇格の要求を理由付きで表す', () => {
    const approval = describeApproval(3, APPROVAL_METHODS.permissions, { reason: 'ネットワーク' });
    expect(approval).toMatchObject({ kind: 'permissions' });
    expect(approval?.detail).toBe('ネットワーク\n許可する対象: なし');
  });

  // issue #1184: 理由が無くても、何を許可するのかが承認カードに出る
  it('権限昇格の要求は理由が無くても許可対象（ネットワーク・パス）を出す', () => {
    const approval = describeApproval(3, APPROVAL_METHODS.permissions, {
      cwd: '/work',
      reason: null,
      permissions: {
        network: { enabled: true },
        fileSystem: {
          read: null,
          write: ['/work/out'],
          entries: [
            { path: { type: 'path', path: '/etc/hosts' }, access: 'read' },
            { path: { type: 'glob_pattern', pattern: '**/*.log' }, access: 'deny' },
            {
              path: { type: 'special', value: { kind: 'project_roots', subpath: 'dist' } },
              access: 'write',
            },
          ],
        },
      },
    });
    expect(approval?.detail).toBe(
      [
        'ネットワーク接続: 許可',
        '書き込み: /work/out',
        '読み取り: /etc/hosts',
        'アクセス禁止: **/*.log',
        '書き込み: プロジェクトルート/dist',
        '(/work)',
      ].join('\n'),
    );
  });

  it('読み取れない権限は内容不明と明示する', () => {
    const approval = describeApproval(3, APPROVAL_METHODS.permissions, {
      reason: '新機能',
      permissions: { network: { enabled: true }, process: { spawn: true } },
    });
    expect(approval?.detail).toBe(
      '新機能\nネットワーク接続: 許可\n内容を読み取れない項目（許可しても付与しません）: process',
    );
  });

  it('知らない要求はundefined（勝手に許可しないため）', () => {
    expect(describeApproval(4, 'item/tool/call', {})).toBeUndefined();
  });
});

describe('summarizePermissions', () => {
  it('RequestPermissionProfile の形をそのまま応答用の権限へ写す', () => {
    const permissions = {
      network: { enabled: null },
      fileSystem: { read: ['/a'], write: null, globScanMaxDepth: 3 },
    };
    const summary = summarizePermissions(permissions);
    expect(summary.lines).toEqual(['読み取り: /a']);
    expect(summary.granted).toEqual(permissions);
    expect(summary.unreadable).toEqual([]);
  });

  it('特別なパスは語で示し、知らない種類は読めない扱いにする', () => {
    const read = (value: unknown) =>
      summarizePermissions({
        fileSystem: { entries: [{ path: { type: 'special', value }, access: 'read' }] },
      });
    expect(read({ kind: 'root' }).lines).toEqual(['読み取り: ルート（/ 以下すべて）']);
    expect(read({ kind: 'tmpdir' }).lines).toEqual(['読み取り: 一時ディレクトリ']);
    expect(read({ kind: 'unknown', path: '/opt', subpath: 'x' }).lines).toEqual([
      '読み取り: /opt/x',
    ]);
    expect(read({ kind: 'future' })).toMatchObject({ lines: [], unreadable: ['fileSystem'] });
  });

  it('オブジェクトでない権限は読めない扱いにし、無ければ空とする', () => {
    expect(summarizePermissions('all')).toMatchObject({ granted: {}, unreadable: ['permissions'] });
    expect(summarizePermissions(undefined)).toEqual({ lines: [], granted: {}, unreadable: [] });
  });
});

describe('buildApprovalResponse', () => {
  // issue #1184: 承認カードに出せなかった項目は、許可しても応答へ載せない
  it('権限要求の許可応答は表示した項目だけを返す', () => {
    const params = {
      permissions: { network: { enabled: true }, process: { spawn: true } },
    };
    expect(buildApprovalResponse('permissions', 'accept', params)).toEqual({
      permissions: { network: { enabled: true } },
      scope: 'turn',
    });
    expect(buildApprovalResponse('permissions', 'accept', { permissions: 'all' })).toEqual({
      permissions: {},
      scope: 'turn',
    });
  });

  it('コマンドとファイル変更はdecisionをそのまま返す', () => {
    expect(buildApprovalResponse('command', 'accept', {})).toEqual({ decision: 'accept' });
    expect(buildApprovalResponse('fileChange', 'decline', {})).toEqual({ decision: 'decline' });
    expect(buildApprovalResponse('command', 'acceptForSession', {})).toEqual({
      decision: 'acceptForSession',
    });
  });

  it('権限要求は形が異なり、許可時のみ要求された権限を与える', () => {
    const params = { permissions: { network: { enabled: true } } };
    expect(buildApprovalResponse('permissions', 'accept', params)).toEqual({
      permissions: { network: { enabled: true } },
      scope: 'turn',
    });
    expect(buildApprovalResponse('permissions', 'acceptForSession', params)).toEqual({
      permissions: { network: { enabled: true } },
      scope: 'session',
    });
  });

  it('権限要求を拒否したら権限を与えない', () => {
    expect(
      buildApprovalResponse('permissions', 'decline', { permissions: { network: true } }),
    ).toEqual({ permissions: {}, scope: 'turn' });
  });

  /**
   * issue #354のレビュー指摘（4点目）: `command` / `fileChange`はdecisionをそのまま
   * 返すため、`cancel`（画面を閉じるとき・接続断で使う値）もそのまま`{ decision: 'cancel' }`
   * として送られる。design.mdはこの経路の応答語彙を`accept` / `acceptForSession` /
   * `decline`の3値と書いており、`cancel`は文書上未定義の値。
   *
   * ただし`dispose()`が保留中の要求を`cancel`で解放する挙動自体は design.md
   * 「画面を閉じるときは保留中の要求を全て`cancel`で解放する」に明記された、今回の
   * issue #354より前からの既存仕様（`releasePendingApprovals()`は`dispose()`の
   * 中身を切り出しただけで、この値自体は変えていない）。実際のapp-serverが
   * `cancel`をどう扱うかは実機でしか確認できず、ここを直すのはこのissueの
   * スコープ外と判断し、現状の値を固定するテストだけ残す（`applyPatch`/`execCommand`
   * は`reviewDecision()`経由で`abort`に変換され、この問題を持たない）。
   */
  it('cancelは文書上未定義の値のままcommand/fileChangeへ渡る（既知の課題、現状を固定）', () => {
    expect(buildApprovalResponse('command', 'cancel', {})).toEqual({ decision: 'cancel' });
    expect(buildApprovalResponse('fileChange', 'cancel', {})).toEqual({ decision: 'cancel' });
  });
});

describe('defaultDenyResponse', () => {
  it('ユーザーに聞けない場合は拒否側に倒す', () => {
    expect(defaultDenyResponse(APPROVAL_METHODS.command, {})).toEqual({ decision: 'decline' });
    expect(defaultDenyResponse(APPROVAL_METHODS.permissions, {})).toEqual({
      permissions: {},
      scope: 'turn',
    });
  });
});

describe('旧形式の承認要求', () => {
  it('applyPatchApproval を変更内容付きの承認カードにする', () => {
    const approval = describeApproval(10, APPROVAL_METHODS.applyPatch, {
      callId: 'c1',
      conversationId: 't1',
      fileChanges: { '/a.ts': { type: 'update' }, '/b.ts': { type: 'add' } },
      reason: 'パッチの適用',
    });
    expect(approval).toMatchObject({ requestId: 10, kind: 'applyPatch' });
    expect(approval?.detail).toContain('/a.ts');
    expect(approval?.detail).toContain('/b.ts');
  });

  it('execCommandApproval を配列のコマンドから組み立てる', () => {
    const approval = describeApproval(11, APPROVAL_METHODS.execCommand, {
      callId: 'c2',
      conversationId: 't1',
      command: ['rm', '-rf', 'build'],
      cwd: '/work',
      parsedCmd: [],
    });
    expect(approval).toMatchObject({ requestId: 11, kind: 'execCommand' });
    expect(approval?.detail).toContain('rm -rf build');
    expect(approval?.detail).toContain('/work');
  });

  it('旧形式はReviewDecisionの語彙で応答する', () => {
    expect(buildApprovalResponse('applyPatch', 'accept', {})).toEqual({ decision: 'approved' });
    expect(buildApprovalResponse('execCommand', 'acceptForSession', {})).toEqual({
      decision: 'approved_for_session',
    });
    expect(buildApprovalResponse('execCommand', 'cancel', {})).toEqual({ decision: 'abort' });

    const declined = buildApprovalResponse('applyPatch', 'decline', {}) as {
      decision: { denied: { rejection: string } };
    };
    expect(declined.decision.denied.rejection).not.toBe('');
  });
});

describe('app-serverが投げうる要求すべてに形の合う応答を返す', () => {
  it('旧形式の承認は denied を返す', () => {
    for (const method of [APPROVAL_METHODS.applyPatch, APPROVAL_METHODS.execCommand]) {
      const response = defaultDenyResponse(method, {}) as {
        decision: { denied: { rejection: string } };
      };
      expect(response.decision.denied.rejection).not.toBe('');
    }
  });

  it('ツールからの問い合わせは質問idごとに空の回答を返す', () => {
    const response = defaultDenyResponse(SERVER_REQUEST_METHODS.requestUserInput, {
      itemId: 'i1',
      isBlocking: true,
      questions: [
        { id: 'q1', header: 'h', question: '？' },
        { id: 'q2', header: 'h', question: '？' },
      ],
    });
    expect(response).toEqual({ answers: { q1: { answers: [] }, q2: { answers: [] } } });
  });

  it('質問が無くても answers を持つ形で返す', () => {
    expect(defaultDenyResponse(SERVER_REQUEST_METHODS.requestUserInput, {})).toEqual({
      answers: {},
    });
  });

  it('MCPのelicitationは action で拒否する', () => {
    expect(defaultDenyResponse(SERVER_REQUEST_METHODS.elicitation, {})).toEqual({
      action: 'decline',
    });
  });

  it('拡張が実行できないツール呼び出しは失敗として返す', () => {
    const response = defaultDenyResponse(SERVER_REQUEST_METHODS.toolCall, {
      tool: 'something',
    }) as {
      success: boolean;
      contentItems: { type: string; text: string }[];
    };
    expect(response.success).toBe(false);
    expect(response.contentItems[0]?.type).toBe('inputText');
    expect(response.contentItems[0]?.text).not.toBe('');
  });

  it('値を作れない要求は応答せず undefined を返す（呼び出し側がエラーで解放する）', () => {
    expect(defaultDenyResponse(SERVER_REQUEST_METHODS.attestation, {})).toBeUndefined();
    expect(defaultDenyResponse(SERVER_REQUEST_METHODS.authTokensRefresh, {})).toBeUndefined();
    expect(defaultDenyResponse('まったく知らない要求', {})).toBeUndefined();
  });

  it('ServerRequestの10種を網羅している', () => {
    // codex app-server generate-json-schema の ServerRequest より
    const all = [
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
      'applyPatchApproval',
      'execCommandApproval',
      'item/tool/requestUserInput',
      'mcpServer/elicitation/request',
      'item/tool/call',
      'attestation/generate',
      'account/chatgptAuthTokens/refresh',
    ];
    expect(new Set(Object.values(SERVER_REQUEST_METHODS))).toEqual(new Set(all));
  });
});
