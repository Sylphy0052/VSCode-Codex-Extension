import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatItem } from '../../src/appserver/chatState';
import {
  END_SUMMARY_TIMEOUT_MS,
  EndSummaryRunner,
  buildEndSummaryMaterial,
  buildEndSummaryPrompt,
  cancelledEndSummaryDisplay,
  failedEndSummaryDisplay,
  finishedEndSummaryDisplay,
  pendingEndSummaryDisplay,
  resolveEndSummaryModel,
  type EndSummaryDisplay,
  type EndSummaryMaterial,
  type EndSummaryRunOptions,
  type EndSummarySettings,
} from '../../src/view/endSummary';
import type { HeadlessCliDeps, HeadlessOutcome } from '../../src/loop/headlessCli';

function item(kind: string, text: string, detail = ''): ChatItem {
  return {
    id: `${kind}-${text}`,
    kind,
    text,
    detail,
    status: undefined,
    turnId: undefined,
    diffs: [],
  };
}

const user = (text: string): ChatItem => item('userMessage', text);
const agent = (text: string): ChatItem => item('agentMessage', text);
const command = (detail: string): ChatItem => item('commandExecution', '', detail);

const material: EndSummaryMaterial = {
  user: '直してください',
  response: '直しました',
  commands: ['npm test', 'git status'],
  editedFiles: ['src/a.ts'],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildEndSummaryMaterial', () => {
  it('利用者の発言が1つも無ければundefinedを返す', () => {
    expect(buildEndSummaryMaterial([], 'done', ['a.ts'])).toBeUndefined();
    expect(buildEndSummaryMaterial([agent('こんにちは')], 'done', [])).toBeUndefined();
  });

  it('空白だけの発言は利用者の発言とみなさず、その手前の発言を探す', () => {
    const result = buildEndSummaryMaterial(
      [user('本当の依頼'), agent('途中'), user('   \n'), agent('返答')],
      '結果',
      [],
    );
    expect(result?.user).toBe('本当の依頼');
    expect(result?.response).toBe('結果');
  });

  it('最後の利用者の発言より後ろだけをそのターンとして集める', () => {
    const result = buildEndSummaryMaterial(
      [
        user('前のターン'),
        command('前のコマンド'),
        user('今のターン'),
        command('今のコマンド'),
        command('  '),
        agent('途中の応答'),
      ],
      '最終応答',
      [],
    );
    expect(result).toEqual({
      user: '今のターン',
      response: '最終応答',
      commands: ['今のコマンド'],
      editedFiles: [],
    });
  });

  it('コマンドは空白を1つに畳み、200文字で切って省略記号を付ける', () => {
    const long = 'a'.repeat(250);
    const result = buildEndSummaryMaterial(
      [user('依頼'), command('echo   hello\n  world'), command(long)],
      '応答',
      [],
    );
    expect(result?.commands[0]).toBe('echo hello world');
    expect(result?.commands[1]).toBe(`${'a'.repeat(200)}…`);
  });

  it('コマンドがちょうど200文字なら省略記号を付けない', () => {
    const exact = 'b'.repeat(200);
    const result = buildEndSummaryMaterial([user('依頼'), command(exact)], '応答', []);
    expect(result?.commands).toEqual([exact]);
  });

  it('結果の本文が空なら、そのターンのagentMessageを空でないものだけ連結して使う', () => {
    const result = buildEndSummaryMaterial(
      [user('依頼'), agent(' 一つ目 '), agent(''), item('reasoning', '思考'), agent('二つ目')],
      '  ',
      [],
    );
    expect(result?.response).toBe('一つ目\n\n二つ目');
  });

  it('結果の本文があればagentMessageは使わない', () => {
    const result = buildEndSummaryMaterial([user('依頼'), agent('途中')], ' 結果 ', []);
    expect(result?.response).toBe('結果');
  });

  it('応答・コマンド・編集がどれも無ければundefinedを返す', () => {
    expect(buildEndSummaryMaterial([user('依頼')], '', [])).toBeUndefined();
    expect(
      buildEndSummaryMaterial([user('依頼'), command('  '), agent('  ')], ' ', []),
    ).toBeUndefined();
  });

  it('応答が無くてもコマンドだけ、あるいは編集だけで材料を返す', () => {
    const onlyCommand = buildEndSummaryMaterial([user('依頼'), command('ls')], '', []);
    expect(onlyCommand).toEqual({ user: '依頼', response: '', commands: ['ls'], editedFiles: [] });
    const onlyEdit = buildEndSummaryMaterial([user('依頼')], '', ['a.ts']);
    expect(onlyEdit).toEqual({ user: '依頼', response: '', commands: [], editedFiles: ['a.ts'] });
  });

  it('編集ファイルは重複を除く', () => {
    const result = buildEndSummaryMaterial([user('依頼')], '応答', ['a.ts', 'b.ts', 'a.ts']);
    expect(result?.editedFiles).toEqual(['a.ts', 'b.ts']);
  });

  it('コマンドは40件、ファイルは60件で切り、超えた件数を末尾に残す', () => {
    const commands = Array.from({ length: 45 }, (_, i) => command(`cmd${i}`));
    const files = Array.from({ length: 60 }, (_, i) => `f${i}.ts`);
    const atLimit = buildEndSummaryMaterial([user('依頼'), ...commands], '応答', files);
    expect(atLimit?.commands).toHaveLength(41);
    expect(atLimit?.commands[39]).toBe('cmd39');
    expect(atLimit?.commands[40]).toBe('…ほか5件');
    expect(atLimit?.editedFiles).toEqual(files);

    const over = buildEndSummaryMaterial([user('依頼')], '応答', [
      ...files,
      'extra1.ts',
      'extra2.ts',
    ]);
    expect(over?.editedFiles).toHaveLength(61);
    expect(over?.editedFiles[60]).toBe('…ほか2件');
  });

  it('長い発言と応答は先頭と末尾を残して真ん中を落とす', () => {
    const userText = `${'U'.repeat(1_500)}${'V'.repeat(1_500)}`;
    const responseText = `${'R'.repeat(4_000)}${'S'.repeat(4_000)}`;
    const result = buildEndSummaryMaterial([user(userText)], responseText, []);
    expect(result?.user).toBe(`${'U'.repeat(1_000)}\n…（中略）…\n${'V'.repeat(1_000)}`);
    expect(result?.response).toBe(`${'R'.repeat(3_000)}\n…（中略）…\n${'S'.repeat(3_000)}`);
  });

  it('上限ちょうどの発言は切らず、前後の空白だけ落とす', () => {
    const exact = 'x'.repeat(2_000);
    const result = buildEndSummaryMaterial([user(`  ${exact}\n`)], '応答', []);
    expect(result?.user).toBe(exact);
  });
});

describe('buildEndSummaryPrompt', () => {
  it('発言・コマンド・ファイル・応答を所定の見出しの下へ並べる', () => {
    const prompt = buildEndSummaryPrompt(material);
    expect(prompt).toContain('### 利用者の発言\n\n直してください\n');
    expect(prompt).toContain('### 実行したコマンド\n\n- npm test\n- git status\n');
    expect(prompt).toContain('### 変更したファイル\n\n- src/a.ts\n');
    expect(prompt.endsWith('### AIの最終応答\n\n直しました')).toBe(true);
  });

  it('空の項目は（無し）と書く', () => {
    const prompt = buildEndSummaryPrompt({ user: '', response: '', commands: [], editedFiles: [] });
    expect(prompt).toContain('### 利用者の発言\n\n（無し）\n');
    expect(prompt).toContain('### 実行したコマンド\n\n（無し）\n');
    expect(prompt).toContain('### 変更したファイル\n\n（無し）\n');
    expect(prompt.endsWith('### AIの最終応答\n\n（無し）')).toBe(true);
  });
});

describe('resolveEndSummaryModel', () => {
  it('明示したモデルはそのまま返す', () => {
    expect(resolveEndSummaryModel('my-model', 'claude')).toBe('my-model');
    expect(resolveEndSummaryModel('my-model', 'codex')).toBe('my-model');
  });

  it('autoまたは空文字はプロバイダごとの既定へ解決する', () => {
    expect(resolveEndSummaryModel('auto', 'claude')).toBe('auto');
    expect(resolveEndSummaryModel('', 'claude')).toBe('auto');
    const codex = resolveEndSummaryModel('auto', 'codex');
    expect(codex).not.toBe('auto');
    expect(resolveEndSummaryModel('', 'codex')).toBe(codex);
  });
});

describe('注記カードの表示', () => {
  it('実行中の表示にrunnerを含める', () => {
    expect(pendingEndSummaryDisplay('codex ・ model: auto')).toEqual({
      status: 'inProgress',
      text: 'このターンの内容を要約しています…',
      detail: '実行中… ・ codex ・ model: auto',
    });
  });

  it('完了の表示は要約の前後の空白を落とす', () => {
    expect(finishedEndSummaryDisplay('\n- 直した\n', 'r')).toEqual({
      status: 'completed',
      text: '- 直した',
      detail: '別のAIによる要約（作業中のAIには送っていません） ・ r',
    });
  });

  it('失敗の表示は時間切れとそれ以外で文言を分ける', () => {
    expect(failedEndSummaryDisplay('timeout', 'r')).toEqual({
      status: 'failed',
      text: '要約できませんでした（時間内に応答がありませんでした）',
      detail: '会話そのものには影響しません ・ r',
    });
    expect(failedEndSummaryDisplay('process-error', 'r').text).toBe(
      '要約できませんでした（CLIが応答しませんでした）',
    );
  });

  it('取り消しの表示は理由とrunnerを持つ', () => {
    expect(cancelledEndSummaryDisplay('閉じたため', 'r')).toEqual({
      status: 'cancelled',
      text: '要約を取り消しました（閉じたため）',
      detail: 'r',
    });
  });
});

interface Call {
  deps: HeadlessCliDeps;
  prompt: string;
  resolve: (outcome: HeadlessOutcome) => void;
  reject: (error: unknown) => void;
}

/** 実CLIを起動しない差し替え。呼び出しごとに手動で解決できる。 */
function makeRunner(): { runner: EndSummaryRunner; calls: Call[] } {
  const calls: Call[] = [];
  let seq = 0;
  const runner = new EndSummaryRunner(
    (deps, prompt) =>
      new Promise<HeadlessOutcome>((resolve, reject) => {
        calls.push({ deps, prompt, resolve, reject });
      }),
    () => `id${++seq}`,
  );
  return { runner, calls };
}

const settings = (over: Partial<EndSummarySettings> = {}): EndSummarySettings => ({
  enabled: true,
  provider: 'inherit',
  model: 'auto',
  effort: '',
  ...over,
});

function makeOptions(over: Partial<EndSummaryRunOptions> = {}): {
  options: EndSummaryRunOptions;
  notes: Array<{ id: string; display: EndSummaryDisplay }>;
  executableFor: ReturnType<typeof vi.fn>;
} {
  const notes: Array<{ id: string; display: EndSummaryDisplay }> = [];
  const executableFor = vi.fn((provider: string) => `/bin/${provider}`);
  const options: EndSummaryRunOptions = {
    settings: settings(),
    host: 'claude',
    executableFor,
    material,
    note: (id, display) => notes.push({ id, display }),
    ...over,
  };
  return { options, notes, executableFor };
}

/** 要約が終わって、実行中でなくなるまで待つ。実行中の解除はthen/catch/finallyの連鎖の最後で行われる。 */
async function untilSettled(runner: EndSummaryRunner): Promise<void> {
  await vi.waitFor(() => {
    expect(runner.running).toBe(false);
  });
}

/**
 * 何も起きないことを確かめる前に、積まれたマイクロタスクを全部流す。連鎖の段数に依存しないよう、
 * マイクロタスクより後に回るマクロタスクを1つ挟む。
 */
async function drainMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('EndSummaryRunner', () => {
  it('開始すると実行中の注記を出し、完了で要約の注記に置き換えて実行中でなくなる', async () => {
    const { runner, calls } = makeRunner();
    const { options, notes } = makeOptions();
    expect(runner.running).toBe(false);

    runner.start(options);
    expect(runner.running).toBe(true);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.id).toBe('id1');
    expect(notes[0]?.display.status).toBe('inProgress');
    expect(notes[0]?.display.detail).toBe('実行中… ・ claude ・ model: auto');

    calls[0]?.resolve({ ok: true, text: '  - 直した\n' });
    await untilSettled(runner);

    expect(notes).toHaveLength(2);
    expect(notes[1]).toEqual({
      id: 'id1',
      display: finishedEndSummaryDisplay('- 直した', 'claude ・ model: auto'),
    });
    expect(runner.running).toBe(false);
  });

  it('CLIへ渡す引数はプロバイダ解決・モデル解決・effortの空白除去・タイムアウトを反映する', () => {
    const { runner, calls } = makeRunner();
    const { options, executableFor } = makeOptions({
      settings: settings({ provider: 'inherit', model: 'auto', effort: ' high ' }),
      host: 'codex',
    });
    runner.start(options);

    const call = calls[0];
    expect(call?.deps.provider).toBe('codex');
    expect(call?.deps.executable).toBe('/bin/codex');
    expect(call?.deps.model).toBe(resolveEndSummaryModel('auto', 'codex'));
    expect(call?.deps.effort).toBe('high');
    expect(call?.deps.timeoutMs).toBe(END_SUMMARY_TIMEOUT_MS);
    expect(call?.deps.kind).toBe('endSummary');
    expect(call?.deps.signal?.aborted).toBe(false);
    expect(executableFor).toHaveBeenCalledWith('codex');
    expect(call?.prompt).toBe(buildEndSummaryPrompt(material));
  });

  it('providerを明示すると会話のCLIではなくそちらを起動し、effortがあればrunner表記へ含める', () => {
    const { runner, calls } = makeRunner();
    const { options, notes } = makeOptions({
      settings: settings({ provider: 'claude', model: 'haiku-x', effort: 'low' }),
      host: 'codex',
    });
    runner.start(options);

    expect(calls[0]?.deps.provider).toBe('claude');
    expect(calls[0]?.deps.executable).toBe('/bin/claude');
    expect(calls[0]?.deps.model).toBe('haiku-x');
    expect(notes[0]?.display.detail).toBe('実行中… ・ claude ・ haiku-x ・ effort: low');
  });

  it('logWarnを渡したときだけdepsへ引き継ぐ', () => {
    const withoutWarn = makeRunner();
    withoutWarn.runner.start(makeOptions().options);
    expect('logWarn' in (withoutWarn.calls[0]?.deps ?? {})).toBe(false);

    const withWarn = makeRunner();
    const logWarn = vi.fn();
    withWarn.runner.start(makeOptions({ logWarn }).options);
    expect(withWarn.calls[0]?.deps.logWarn).toBe(logWarn);
  });

  it('認証情報とみられる文字列はCLIへ送る前に伏せ、その旨をlogInfoへ残す', () => {
    const { runner, calls } = makeRunner();
    const logInfo = vi.fn();
    const secret = 'AKIAABCDEFGHIJKLMNOP';
    const { options } = makeOptions({
      material: { ...material, response: `キーは ${secret} です` },
      logInfo,
    });
    runner.start(options);

    expect(calls[0]?.prompt).not.toContain(secret);
    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(logInfo.mock.calls[0]?.[0]).toContain('要約エージェントへ送る前に伏せました');
  });

  it('伏せる箇所が無ければlogInfoを呼ばず、logInfo未指定でも落ちない', () => {
    const first = makeRunner();
    const logInfo = vi.fn();
    first.runner.start(makeOptions({ logInfo }).options);
    expect(logInfo).not.toHaveBeenCalled();

    const second = makeRunner();
    const secret = 'AKIAABCDEFGHIJKLMNOP';
    expect(() =>
      second.runner.start(makeOptions({ material: { ...material, response: secret } }).options),
    ).not.toThrow();
    expect(second.calls[0]?.prompt).not.toContain(secret);
  });

  it('応答が空白だけならprocess-errorの失敗として警告と失敗の注記を残す', async () => {
    const { runner, calls } = makeRunner();
    const logWarn = vi.fn();
    const { options, notes } = makeOptions({ logWarn });
    runner.start(options);

    calls[0]?.resolve({ ok: true, text: '  \n' });
    await untilSettled(runner);

    expect(logWarn).toHaveBeenCalledWith(
      '要約エージェントの呼び出しに失敗しました（process-error）',
    );
    expect(notes[1]?.display).toEqual(
      failedEndSummaryDisplay('process-error', 'claude ・ model: auto'),
    );
    expect(runner.running).toBe(false);
  });

  it('CLIが時間切れを返したら、logWarn未指定でもtimeoutの失敗として注記を残す', async () => {
    const { runner, calls } = makeRunner();
    const { options, notes } = makeOptions();
    runner.start(options);

    calls[0]?.resolve({ ok: false, reason: 'timeout' });
    await untilSettled(runner);

    expect(notes[1]?.display.status).toBe('failed');
    expect(notes[1]?.display.text).toBe('要約できませんでした（時間内に応答がありませんでした）');
  });

  it('実行が例外で落ちたら警告を残して失敗の注記を出す', async () => {
    const { runner, calls } = makeRunner();
    const logWarn = vi.fn();
    const { options, notes } = makeOptions({ logWarn });
    runner.start(options);

    calls[0]?.reject(new Error('spawn失敗'));
    await untilSettled(runner);

    expect(logWarn).toHaveBeenCalledWith('要約エージェントで例外が出ました: spawn失敗');
    expect(notes[1]?.display.status).toBe('failed');
    expect(runner.running).toBe(false);
  });

  it('Errorでない値が投げられても文字列化して警告し、失敗の注記を出す', async () => {
    const { runner, calls } = makeRunner();
    const logWarn = vi.fn();
    const { options, notes } = makeOptions({ logWarn });
    runner.start(options);
    calls[0]?.reject('文字列の例外');
    await untilSettled(runner);
    expect(logWarn).toHaveBeenCalledWith('要約エージェントで例外が出ました: 文字列の例外');
    expect(notes[1]?.display.status).toBe('failed');
  });

  it('例外で落ちても、logWarn未指定なら警告を出さずに失敗の注記だけ出す', async () => {
    const { runner, calls } = makeRunner();
    const { options, notes } = makeOptions();
    runner.start(options);
    calls[0]?.reject(new Error('x'));
    await untilSettled(runner);
    expect(notes[1]?.display.status).toBe('failed');
  });

  it('次のターンが来たら、前の要約を取り消して新しい要約を始める', () => {
    const { runner, calls } = makeRunner();
    const { options, notes } = makeOptions();
    runner.start(options);
    runner.start(options);

    expect(calls[0]?.deps.signal?.aborted).toBe(true);
    expect(calls[1]?.deps.signal?.aborted).toBe(false);
    expect(notes.map((n) => [n.id, n.display.status])).toEqual([
      ['id1', 'inProgress'],
      ['id1', 'cancelled'],
      ['id2', 'inProgress'],
    ]);
    expect(notes[1]?.display.text).toBe('要約を取り消しました（次のターンが終わったため）');
  });

  it('取り消した側の結果が後から届いても、注記を上書きせず新しい要約の実行中状態も消さない', async () => {
    const { runner, calls } = makeRunner();
    const { options, notes } = makeOptions();
    runner.start(options);
    runner.start(options);

    calls[0]?.resolve({ ok: true, text: '古い要約' });
    await drainMicrotasks();
    expect(notes).toHaveLength(3);
    // 取り消した側のfinallyが新しい要約の実行中状態を消してはならない
    expect(runner.running).toBe(true);

    calls[1]?.resolve({ ok: true, text: '新しい要約' });
    await untilSettled(runner);
    expect(notes[3]?.id).toBe('id2');
    expect(notes[3]?.display.text).toBe('新しい要約');
  });

  it('取り消した側が例外で終わったときは警告だけ残し、失敗の注記は出さない', async () => {
    const { runner, calls } = makeRunner();
    const logWarn = vi.fn();
    const { options, notes } = makeOptions({ logWarn });
    runner.start(options);
    runner.cancel('手動');

    calls[0]?.reject(new Error('aborted'));
    await vi.waitFor(() => {
      expect(logWarn).toHaveBeenCalledWith('要約エージェントで例外が出ました: aborted');
    });

    expect(notes.map((n) => n.display.status)).toEqual(['inProgress', 'cancelled']);
  });

  it('cancelは理由付きの取り消し注記を残して実行中でなくする', () => {
    const { runner, calls } = makeRunner();
    const { options, notes } = makeOptions();
    runner.start(options);

    runner.cancel('利用者が止めた');

    expect(runner.running).toBe(false);
    expect(calls[0]?.deps.signal?.aborted).toBe(true);
    expect(notes[1]).toEqual({
      id: 'id1',
      display: cancelledEndSummaryDisplay('利用者が止めた', 'claude ・ model: auto'),
    });
  });

  it('走っていないときのcancelは何もしない', () => {
    const { runner } = makeRunner();
    expect(() => runner.cancel('なし')).not.toThrow();
    expect(runner.running).toBe(false);
  });

  it('disposeはプロセスを止めるが注記は残さず、その後のcancelも何も出さない', async () => {
    const { runner, calls } = makeRunner();
    const { options, notes } = makeOptions();
    runner.start(options);

    runner.dispose();

    expect(calls[0]?.deps.signal?.aborted).toBe(true);
    expect(runner.running).toBe(false);
    runner.cancel('後から');
    calls[0]?.resolve({ ok: true, text: '遅れて届いた' });
    await drainMicrotasks();
    expect(notes.map((n) => n.display.status)).toEqual(['inProgress']);
  });

  it('走っていないときのdisposeは何もしない', () => {
    const { runner } = makeRunner();
    expect(() => runner.dispose()).not.toThrow();
    expect(runner.running).toBe(false);
  });

  it('既定のid生成はendSummary:で始まる一意なidを払い出す', () => {
    const runner = new EndSummaryRunner(() => new Promise<HeadlessOutcome>(() => undefined));
    const { options, notes } = makeOptions();
    runner.start(options);
    runner.start(options);
    const ids = notes.filter((n) => n.display.status === 'inProgress').map((n) => n.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^endSummary:[0-9a-f-]{36}$/u);
    expect(ids[1]).not.toBe(ids[0]);
  });

  it('既定の実行関数を使う生成でもrunningは初期状態でfalseになる', () => {
    // 既定引数の分岐を踏むだけで、start()は呼ばない（実CLIを起動しない）
    expect(new EndSummaryRunner().running).toBe(false);
  });
});
