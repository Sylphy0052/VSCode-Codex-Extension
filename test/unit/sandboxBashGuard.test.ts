import { describe, expect, it } from 'vitest';
import {
  SANDBOX_BASH_GUARD_CALLBACK_ID,
  answerSandboxBashGuard,
  hasCommandSubstitution,
  sandboxBashGuardHooks,
  sandboxBashGuardReason,
  splitShellCommands,
} from '../../src/claude/sandboxBashGuard';

describe('sandboxBashGuardHooks', () => {
  it('Bashの実行前だけを受けるhookを登録する', () => {
    expect(sandboxBashGuardHooks()).toEqual({
      PreToolUse: [{ matcher: 'Bash', hookCallbackIds: [SANDBOX_BASH_GUARD_CALLBACK_ID] }],
    });
  });
});

describe('splitShellCommands', () => {
  it('連結記号でコマンドごとの語の列に分ける', () => {
    const result = splitShellCommands('cd a && git push; echo hi | cat || true\nls & pwd');
    expect(result.map((c) => c.words)).toEqual([
      ['cd', 'a'],
      ['git', 'push'],
      ['echo', 'hi'],
      ['cat'],
      ['true'],
      ['ls'],
      ['pwd'],
    ]);
    expect(result.every((c) => !c.redirected)).toBe(true);
  });

  it('括弧とバッククォートも区切りにする', () => {
    const result = splitShellCommands('(cd a) `gh pr list`');
    expect(result.map((c) => c.words)).toEqual([
      ['cd', 'a'],
      ['gh', 'pr', 'list'],
    ]);
  });

  it('空文字列や空白だけならコマンドを返さない', () => {
    expect(splitShellCommands('')).toEqual([]);
    expect(splitShellCommands('  \t ; ')).toEqual([]);
  });

  it('引用符の中は区切らず、引用符そのものは外す', () => {
    expect(splitShellCommands(`gh pr create --title "a; b && c" --body 'x | y'`)[0]?.words).toEqual(
      ['gh', 'pr', 'create', '--title', 'a; b && c', '--body', 'x | y'],
    );
  });

  it('二重引用符の中のバックスラッシュは次の1文字をそのまま取り込む', () => {
    expect(splitShellCommands('echo "a\\"b"')[0]?.words).toEqual(['echo', 'a"b']);
  });

  it('単引用符の中のバックスラッシュはそのまま残す', () => {
    expect(splitShellCommands("echo 'a\\b'")[0]?.words).toEqual(['echo', 'a\\b']);
  });

  it('末尾の閉じていない引用符でも例外にならず、中身を語にする', () => {
    expect(splitShellCommands('echo "abc')[0]?.words).toEqual(['echo', 'abc']);
  });

  it('空の引用符は空の語として残す', () => {
    expect(splitShellCommands('echo ""')[0]?.words).toEqual(['echo', '']);
  });

  it('引用符の外のバックスラッシュは次の文字をエスケープする', () => {
    expect(splitShellCommands('echo a\\ b\\;c')[0]?.words).toEqual(['echo', 'a b;c']);
  });

  it('行末のバックスラッシュ改行は区切りにせず継続として扱う', () => {
    const result = splitShellCommands('gh pr \\\nlist');
    expect(result).toHaveLength(1);
    expect(result[0]?.words).toEqual(['gh', 'pr', 'list']);
  });

  it('文字列末尾のバックスラッシュはそのまま語に残る', () => {
    expect(splitShellCommands('echo a\\')[0]?.words).toEqual(['echo', 'a\\']);
  });

  it('出力のリダイレクトとその行き先を語から除き、redirectedにする', () => {
    expect(splitShellCommands('gh issue view 1 > out.json')).toEqual([
      { words: ['gh', 'issue', 'view', '1'], redirected: true },
    ]);
    expect(splitShellCommands('gh issue view 1 >out.json')).toEqual([
      { words: ['gh', 'issue', 'view', '1'], redirected: true },
    ]);
    expect(splitShellCommands('gh issue view 1 >> out.json')).toEqual([
      { words: ['gh', 'issue', 'view', '1'], redirected: true },
    ]);
  });

  it('&>と数字付きのリダイレクトも出力のファイル書き込みとして扱う', () => {
    expect(splitShellCommands('gh x &> log')).toEqual([{ words: ['gh', 'x'], redirected: true }]);
    expect(splitShellCommands('gh x 2> err')).toEqual([{ words: ['gh', 'x'], redirected: true }]);
    expect(splitShellCommands('gh x 2>/dev/null')).toEqual([
      { words: ['gh', 'x'], redirected: true },
    ]);
  });

  it('>&fileはファイルへの書き込みで、行き先も語から除く', () => {
    expect(splitShellCommands('gh x >& log')).toEqual([{ words: ['gh', 'x'], redirected: true }]);
  });

  it('fdの複製(2>&1 >&2 >&-)は語に残し、redirectedにしない', () => {
    expect(splitShellCommands('gh x 2>&1')).toEqual([
      { words: ['gh', 'x', '2>&1'], redirected: false },
    ]);
    expect(splitShellCommands('gh x >&2')).toEqual([
      { words: ['gh', 'x', '>&2'], redirected: false },
    ]);
    expect(splitShellCommands('gh x >&-')).toEqual([
      { words: ['gh', 'x', '>&-'], redirected: false },
    ]);
  });

  it('入力のリダイレクト(<)の語は残る。<&はfd複製として&を語に含める', () => {
    expect(splitShellCommands('cat < in.txt')[0]).toEqual({
      words: ['cat', '<', 'in.txt'],
      redirected: false,
    });
    expect(splitShellCommands('cat <&3')[0]?.words).toEqual(['cat', '<&3']);
  });

  it('x>outのxは別の語として残し、行き先だけを除く', () => {
    expect(splitShellCommands('echo x>out')).toEqual([{ words: ['echo', 'x'], redirected: true }]);
  });

  it('リダイレクトが続くと行き先は後ろのものになる', () => {
    expect(splitShellCommands('gh x > > out y')).toEqual([
      { words: ['gh', 'x', 'y'], redirected: true },
    ]);
  });

  it('リダイレクトの行き先を待つ間に連結が来ると、次のコマンドは巻き込まない', () => {
    const result = splitShellCommands('gh x > ; git push');
    expect(result).toEqual([
      { words: ['gh', 'x'], redirected: true },
      { words: ['git', 'push'], redirected: false },
    ]);
  });

  it('引用符の中の>はリダイレクトにしない', () => {
    expect(splitShellCommands(`gh pr create --body "> 引用"`)).toEqual([
      { words: ['gh', 'pr', 'create', '--body', '> 引用'], redirected: false },
    ]);
  });

  it('redirectedはコマンドごとに独立する', () => {
    const result = splitShellCommands('echo a > f; gh pr list');
    expect(result.map((c) => c.redirected)).toEqual([true, false]);
  });
});

describe('hasCommandSubstitution', () => {
  it('$()とバッククォートを検出する', () => {
    expect(hasCommandSubstitution('echo $(date)')).toBe(true);
    expect(hasCommandSubstitution('echo `date`')).toBe(true);
  });

  it('二重引用符の中の置換も検出する', () => {
    expect(hasCommandSubstitution('gh pr create --body "$(cat f)"')).toBe(true);
  });

  it('単引用符の中の置換は検出しない', () => {
    expect(hasCommandSubstitution(`echo '$(date) \`x\`'`)).toBe(false);
  });

  it('単引用符が閉じたあとの置換は検出する', () => {
    expect(hasCommandSubstitution(`echo 'a' $(date)`)).toBe(true);
  });

  it('二重引用符の中の単引用符は引用の開始にならない', () => {
    expect(hasCommandSubstitution(`echo "it's" $(date)`)).toBe(true);
  });

  it('バックスラッシュでエスケープされた記号は検出しない', () => {
    expect(hasCommandSubstitution('echo \\$(date)')).toBe(false);
    expect(hasCommandSubstitution('echo \\`date\\`')).toBe(false);
  });

  it('$だけ、置換のない文字列は検出しない', () => {
    expect(hasCommandSubstitution('echo $HOME ${x}')).toBe(false);
    expect(hasCommandSubstitution('')).toBe(false);
  });
});

describe('sandboxBashGuardReason', () => {
  it('単独のネットワークコマンドは通す', () => {
    expect(sandboxBashGuardReason('git push origin main')).toBeUndefined();
    expect(sandboxBashGuardReason('gh pr list')).toBeUndefined();
    expect(sandboxBashGuardReason('docker ps')).toBeUndefined();
  });

  it('ネットワークコマンドでないものは連結していても通す', () => {
    expect(sandboxBashGuardReason('ls -la')).toBeUndefined();
    expect(sandboxBashGuardReason('cd a && git status')).toBeUndefined();
    expect(sandboxBashGuardReason('git status; git log')).toBeUndefined();
    expect(sandboxBashGuardReason('')).toBeUndefined();
  });

  it('サブコマンドが除外パターンに無いgitは通す', () => {
    expect(sandboxBashGuardReason('git commit -m x && git status')).toBeUndefined();
    expect(sandboxBashGuardReason('git')).toBeUndefined();
  });

  it('cdとの連結を拒否し、単独で打ち直す形を示す', () => {
    const reason = sandboxBashGuardReason('cd /repo && git push origin main');
    expect(reason).toContain('git pushがsandboxの外で走る');
    expect(reason).toContain('次の形で1つずつ別のBash呼び出しとして打ち直す: git push origin main');
    expect(reason).toContain('sandbox下で出力をファイルへ保存する手段は無い');
  });

  it('複数のネットワークコマンドを全部案内し、名前は重複を除く', () => {
    const reason = sandboxBashGuardReason('gh pr list; gh issue list; curl example.com');
    expect(reason).toContain('gh・curlがsandboxの外で走る');
    expect(reason).toContain('gh pr list / gh issue list / curl example.com');
  });

  it('パイプとの連結を拒否する', () => {
    const reason = sandboxBashGuardReason('gh api x | jq .');
    expect(reason).toContain('打ち直す: gh api x\n');
    expect(reason).not.toContain('gh api x |');
  });

  it('git -Cなど先頭の引数が挟まるgitを拒否し、サブコマンド以降だけ打ち直しに使う', () => {
    const reason = sandboxBashGuardReason('git -C /repo push origin main');
    expect(reason).toContain('打ち直す: git push origin main');
  });

  it('値を取るgitオプションは2語、取らないものは1語として読み飛ばす', () => {
    expect(sandboxBashGuardReason('git -c core.x=1 fetch origin')).toContain(
      '打ち直す: git fetch origin',
    );
    expect(sandboxBashGuardReason('git --no-pager pull')).toContain('打ち直す: git pull');
    expect(sandboxBashGuardReason('git --git-dir .git --work-tree . ls-remote o')).toContain(
      '打ち直す: git ls-remote o',
    );
  });

  it('環境変数の代入が先頭にあるコマンドを拒否する', () => {
    const reason = sandboxBashGuardReason('GH_TOKEN=abc FOO=1 gh pr list');
    expect(reason).toContain('打ち直す: gh pr list');
    expect(reason).not.toContain('GH_TOKEN');
  });

  it('代入だけで語が尽きたコマンドは対象にしない', () => {
    expect(sandboxBashGuardReason('FOO=1')).toBeUndefined();
    expect(sandboxBashGuardReason('FOO=1; BAR=2')).toBeUndefined();
  });

  it('ラッパー越しのネットワークコマンドを拒否する', () => {
    for (const wrapper of ['env', 'nohup', 'sudo -u root', 'timeout -s SIGKILL 60']) {
      const reason = sandboxBashGuardReason(`${wrapper} git push origin main`);
      expect(reason, wrapper).toContain('打ち直す: git push origin main');
    }
  });

  it('ラッパーの後ろにネットワークコマンドが無ければ対象にしない', () => {
    expect(sandboxBashGuardReason('timeout 60 npm test')).toBeUndefined();
    expect(sandboxBashGuardReason('env')).toBeUndefined();
    expect(sandboxBashGuardReason('time; gh pr list')).toContain('打ち直す: gh pr list');
  });

  it('出力のリダイレクトが付いた単独のコマンドを拒否し、保存手段が無いことを案内する', () => {
    const reason = sandboxBashGuardReason('gh issue view 1 > out.json');
    expect(reason).toContain('打ち直す: gh issue view 1');
    expect(reason).not.toContain('out.json /');
    expect(reason).toContain('sandbox下で出力をファイルへ保存する手段は無い');
  });

  it('fdの複製だけなら単独のコマンドは通す', () => {
    expect(sandboxBashGuardReason('gh issue view 1 2>&1')).toBeUndefined();
  });

  it('連結なし・リダイレクトなしの拒否では保存手段の案内を付けない', () => {
    const reason = sandboxBashGuardReason('GH_TOKEN=x gh pr list');
    expect(reason).toBeDefined();
    expect(reason).not.toContain('sandbox下で出力をファイルへ保存する手段は無い');
  });

  it('打ち直しの例では空白や記号を含む語を単引用符で囲む', () => {
    const reason = sandboxBashGuardReason(
      `cd a && gh pr create --title "a b" --body "it's" --label x`,
    );
    expect(reason).toContain(`gh pr create --title 'a b' --body 'it'\\''s' --label x`);
  });

  it('打ち直しの例でfdの複製と入力のリダイレクトは囲まない', () => {
    const reason = sandboxBashGuardReason('cd a && gh api x 2>&1 <in.json');
    expect(reason).toContain('gh api x 2>&1 <in.json');
  });

  it('二重引用符の中の>で始まる語は囲んで残す', () => {
    const reason = sandboxBashGuardReason('cd a && gh pr comment --body "> 引用"');
    expect(reason).toContain(`gh pr comment --body '> 引用'`);
  });

  it('引数のあるコマンド置換は、ネットワークコマンドが含まれるとき置換の案内で拒否する', () => {
    const reason = sandboxBashGuardReason(`gh pr create --body "$(cat <<'EOF'\nbody\nEOF\n)"`);
    expect(reason).toContain('ghの引数にコマンド置換');
    expect(reason).toContain('--body-file <path>');
    expect(reason).toContain('--field description=@<path>');
    expect(reason).toContain('短い値なら、置換を使わず値そのものを引数に書く。');
  });

  it('コマンド置換の案内でも名前の重複を除いて並べる', () => {
    const reason = sandboxBashGuardReason('gh a "$(x)"; gh b; git push o');
    expect(reason).toContain('gh・git pushの引数にコマンド置換');
  });

  it('ネットワークコマンドを含まないコマンド置換は通す', () => {
    expect(sandboxBashGuardReason('echo $(date)')).toBeUndefined();
    expect(sandboxBashGuardReason('echo `date`')).toBeUndefined();
  });

  it('単引用符の中にしかない置換記号は置換の案内にしない', () => {
    expect(sandboxBashGuardReason(`gh pr create --body '$(x)'`)).toBeUndefined();
  });
});

describe('answerSandboxBashGuard', () => {
  const payload = (command: unknown, extra: Record<string, unknown> = {}) => ({
    callback_id: SANDBOX_BASH_GUARD_CALLBACK_ID,
    input: { tool_name: 'Bash', tool_input: { command }, ...extra },
  });

  it('拒否対象のコマンドにはdenyの応答を返す', () => {
    const answer = answerSandboxBashGuard(payload('cd a && git push'));
    expect(answer).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: sandboxBashGuardReason('cd a && git push'),
      },
    });
    expect(sandboxBashGuardReason('cd a && git push')).toBeDefined();
  });

  it('拒否しないコマンドには空の応答を返す', () => {
    expect(answerSandboxBashGuard(payload('git push origin main'))).toEqual({});
  });

  it('別のcallback_idには空の応答を返す', () => {
    expect(
      answerSandboxBashGuard({ ...payload('cd a && git push'), callback_id: 'other' }),
    ).toEqual({});
    expect(answerSandboxBashGuard({})).toEqual({});
  });

  it('inputやtool_inputが無い、Bash以外、commandが文字列でないときは空の応答を返す', () => {
    const id = SANDBOX_BASH_GUARD_CALLBACK_ID;
    expect(answerSandboxBashGuard({ callback_id: id })).toEqual({});
    expect(answerSandboxBashGuard({ callback_id: id, input: { tool_name: 'Bash' } })).toEqual({});
    expect(answerSandboxBashGuard(payload(42))).toEqual({});
    expect(answerSandboxBashGuard(payload(undefined))).toEqual({});
    expect(
      answerSandboxBashGuard({
        callback_id: id,
        input: { tool_name: 'Read', tool_input: { command: 'cd a && git push' } },
      }),
    ).toEqual({});
  });
});
