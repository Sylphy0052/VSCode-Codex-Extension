import { describe, expect, it } from 'vitest';
import { hintForInput } from '../../src/provider/slashCommands';

const commands = [
  { name: 'copy', description: '直近の応答をコピーする', argumentHint: 'N' },
  {
    name: 'sandbox-add-read-dir',
    description: '読み取りを許すディレクトリを足す',
    argumentHint: '<absolute_path>',
  },
  { name: 'compact', description: '会話を圧縮する', argumentHint: '' },
];

describe('hintForInput', () => {
  it('コマンドを打ち終えて空白を入れたらヒントを返す', () => {
    expect(hintForInput('/copy ', commands)).toEqual({ name: 'copy', argumentHint: 'N' });
  });

  it('引数を打ち始めてもヒントは出したまま', () => {
    // 書き方が分からないと打てないので、打っている間こそ見えている必要がある
    expect(hintForInput('/sandbox-add-read-dir /tmp/w', commands)?.argumentHint).toBe(
      '<absolute_path>',
    );
  });

  it('空白の前（まだ候補を選んでいる途中）では返さない', () => {
    // 候補一覧そのものにヒントが出ているため、二重に出さない
    expect(hintForInput('/cop', commands)).toBeUndefined();
    expect(hintForInput('/copy', commands)).toBeUndefined();
  });

  it('引数を取らないコマンドでは返さない', () => {
    expect(hintForInput('/compact ', commands)).toBeUndefined();
  });

  it('知らないコマンドでは返さない', () => {
    expect(hintForInput('/unknown ', commands)).toBeUndefined();
  });

  it('スラッシュで始まらない入力では返さない', () => {
    expect(hintForInput('こんにちは', commands)).toBeUndefined();
    expect(hintForInput('', commands)).toBeUndefined();
  });

  it('複数行のときは最後の行だけを見る', () => {
    expect(hintForInput('前の行\n/copy ', commands)?.name).toBe('copy');
    expect(hintForInput('/copy \n普通の文章', commands)).toBeUndefined();
  });

  it('行頭でないスラッシュは対象にしない', () => {
    // パスを書いているときに誤って拾わないため
    expect(hintForInput('見て /copy ', commands)).toBeUndefined();
  });
});
