import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ChatState } from '../../src/appserver/chatState';
import {
  buildHandoffFactsSection,
  extractCreatedReferences,
  hasHandoffAcceptance,
  resolveHandoffGitFacts,
  stateHasHandoffAcceptance,
} from '../../src/view/handoffAcceptance';

const ID = '20260930T010203-abc123';

describe('hasHandoffAcceptance', () => {
  it('単独行の一致を受領とみなす', () => {
    expect(hasHandoffAcceptance(`3点\nHANDOFF_ACCEPTED ${ID}\n`, ID)).toBe(true);
  });
  it('idが違う行・装飾付きの行は数えない', () => {
    expect(hasHandoffAcceptance('HANDOFF_ACCEPTED other', ID)).toBe(false);
    expect(hasHandoffAcceptance(`**HANDOFF_ACCEPTED ${ID}**`, ID)).toBe(false);
  });
});

describe('stateHasHandoffAcceptance', () => {
  const state = (items: unknown[]): ChatState => ({ items }) as unknown as ChatState;
  it('agentMessageに行があれば真、userMessageだけなら偽', () => {
    expect(
      stateHasHandoffAcceptance(
        state([{ kind: 'agentMessage', text: `HANDOFF_ACCEPTED ${ID}` }]),
        ID,
      ),
    ).toBe(true);
    expect(
      stateHasHandoffAcceptance(
        state([{ kind: 'userMessage', text: `HANDOFF_ACCEPTED ${ID}` }]),
        ID,
      ),
    ).toBe(false);
  });
});

describe('extractCreatedReferences', () => {
  const cmd = (detail: string, text: string, status = 'completed') =>
    ({ kind: 'commandExecution', detail, text, status }) as never;
  it('成功したcreateの出力URLだけ拾う', () => {
    const refs = extractCreatedReferences([
      cmd('gh pr create --title x', 'https://github.com/o/r/pull/12\n'),
      cmd('gh issue create --title x', 'https://github.com/o/r/issues/7'),
      cmd('gh pr view 3', 'https://github.com/o/r/pull/3'),
      cmd('gh pr create', 'https://github.com/o/r/pull/99', 'failed'),
    ]);
    expect(refs.map((r) => `${r.kind}#${r.number}`)).toEqual(['pr#12', 'issue#7']);
  });
});

describe('buildHandoffFactsSection', () => {
  it('作成物なしと不明値を表す', () => {
    const text = buildHandoffFactsSection(
      { branch: undefined, head: 'abc', diffHash: 'clean' },
      [],
    );
    expect(text).toContain('branch: 不明');
    expect(text).toContain('作成したIssue・PR: なし');
  });
  it('作成物を列挙する', () => {
    const text = buildHandoffFactsSection({ branch: 'b', head: 'h', diffHash: 'd' }, [
      { kind: 'pr', number: '5', url: 'https://x/pull/5' },
    ]);
    expect(text).toContain('PR #5 (https://x/pull/5)');
  });
});

describe('resolveHandoffGitFacts', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
    dir = undefined;
  });
  it('未追跡ファイルの追加・変更でdiffHashが変わる', async () => {
    dir = mkdtempSync(join(tmpdir(), 'handoff-facts-'));
    const run = (...args: string[]): void => {
      execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    };
    run('init', '-q');
    run('-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '--allow-empty', '-m', 'i');
    expect((await resolveHandoffGitFacts(dir, 'b')).diffHash).toBe('clean');
    writeFileSync(join(dir, 'new.txt'), 'a');
    const first = await resolveHandoffGitFacts(dir, 'b');
    expect(first.diffHash).not.toBe('clean');
    writeFileSync(join(dir, 'new.txt'), 'b');
    const second = await resolveHandoffGitFacts(dir, 'b');
    expect(second.diffHash).not.toBe(first.diffHash);
  });
  it('cwd未指定はundefined', async () => {
    expect(await resolveHandoffGitFacts(undefined, 'b')).toEqual({
      branch: 'b',
      head: undefined,
      diffHash: undefined,
    });
  });
});
