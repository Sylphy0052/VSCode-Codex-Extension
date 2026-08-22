import { describe, expect, it } from 'vitest';
import {
  maskForLog,
  maskHomeDir,
  sanitizeForLog,
  stripControlChars,
  stripControlCharsPreservingNewlines,
} from '../../src/orchestrator/sanitize';

describe('sanitizeForLog（design.md §16.7のsanitizeForReasonを共通化。レビュー指摘: warning）', () => {
  it('制御文字・改行を空白に畳む', () => {
    expect(sanitizeForLog('a\nb\tc\x00d')).toBe('a b c d');
  });

  it('連続する空白を1つに畳む', () => {
    expect(sanitizeForLog('a    b')).toBe('a b');
  });

  it('長すぎる値を切り詰め、省略記号を付ける', () => {
    const long = 'x'.repeat(300);
    const result = sanitizeForLog(long);
    expect(result.length).toBe(201);
    expect(result.endsWith('…')).toBe(true);
  });

  it('URL中のuserinfo（user:pass@）をマスクする', () => {
    const raw =
      "fatal: Authentication failed for 'https://token123:x-oauth-basic@github.com/org/repo.git/'";
    const result = sanitizeForLog(raw);
    expect(result).not.toContain('token123');
    expect(result).not.toContain('x-oauth-basic');
    expect(result).toContain('https://***@github.com/org/repo.git/');
  });

  it('userinfoを含まない通常のURLは変えない', () => {
    expect(sanitizeForLog('see https://github.com/org/repo')).toBe(
      'see https://github.com/org/repo',
    );
  });

  it('双方向制御文字（RTL override等）も取り除く（レビュー指摘: medium 3）', () => {
    // U+202E（RTL override）を使って表示上の文字列反転を狙う典型例
    const rtlOverride = '\u202E';
    const spoofed = 'safe' + rtlOverride + 'gnp.exe';
    const result = sanitizeForLog(spoofed);
    expect(result).not.toContain(rtlOverride);
    expect(result).toBe('safegnp.exe');
  });
});

describe('sanitizeForLog（Issue #474 指摘1: パーセントエンコードされたURLのuserinfo）', () => {
  it('スキームとuserinfoが丸ごとパーセントエンコードされたURLでもuserinfoをマスクする', () => {
    const raw = 'redirect?url=https%3A%2F%2Ftoken%40evil.com%2Fpath';
    const result = sanitizeForLog(raw);
    expect(result).not.toContain('token%40');
    expect(result).toContain('https%3A%2F%2F***%40evil.com%2Fpath');
  });

  it('大文字小文字が混在したパーセントエンコード（%3a%2f%2f等）でもマスクする', () => {
    const raw = 'https%3a%2f%2fsecret%40evil.com';
    const result = sanitizeForLog(raw);
    expect(result).not.toContain('secret%40');
    expect(result).toContain('https%3a%2f%2f***%40evil.com');
  });

  it('パーセントエンコードされたスキーム区切りを伴わない%40は誤マスクしない（過剰マスク防止）', () => {
    // クエリ文字列中の正当な%40（例: メールアドレスのエンコード）は対象外
    const raw = 'redirect?next=%2Fdashboard%3Femail%3Duser%40example.com';
    expect(sanitizeForLog(raw)).toBe(raw);
  });

  it('2回適用しても結果が変わらない（冪等性）', () => {
    const raw = 'https%3A%2F%2Ftoken%40evil.com%2Fpath';
    const once = sanitizeForLog(raw);
    const twice = sanitizeForLog(once);
    expect(twice).toBe(once);
  });
});

describe('sanitizeForLog（ホームディレクトリ配下の絶対パスマスク。Issue #378）', () => {
  it('ホームディレクトリ配下の絶対パス（POSIX）を含むエラーメッセージでユーザー名を露出しない', () => {
    const raw = "EACCES: permission denied, open '/home/alice/project/src/index.ts'";
    const result = sanitizeForLog(raw);
    expect(result).not.toContain('alice');
    // パスの構造（どのファイルで失敗したか）は残る
    expect(result).toContain('/home/***/project/src/index.ts');
  });

  it('macOS形式（/Users/<user>）の絶対パスでもユーザー名を露出しない', () => {
    const raw = "ENOENT: no such file or directory, stat '/Users/bob/repo/foo.ts'";
    const result = sanitizeForLog(raw);
    expect(result).not.toContain('bob');
    expect(result).toContain('/Users/***/repo/foo.ts');
  });

  it('Windows形式（C:\\Users\\<user>）の絶対パスでもユーザー名を露出しない（受入基準）', () => {
    const raw = "EACCES: permission denied, open 'C:\\Users\\carol\\project\\src\\index.ts'";
    const result = sanitizeForLog(raw);
    expect(result).not.toContain('carol');
    expect(result).toContain('C:\\Users\\***\\project\\src\\index.ts');
  });

  it('Windows形式でスラッシュ区切り（C:/Users/<user>）でもユーザー名を露出しない', () => {
    const raw = "EACCES: permission denied, open 'C:/Users/dave/project/src/index.ts'";
    const result = sanitizeForLog(raw);
    expect(result).not.toContain('dave');
    expect(result).toContain('C:/Users/***/project/src/index.ts');
  });

  it('相対パスや通常の文字列は変えない（過剰マスク防止の自己レビュー）', () => {
    expect(sanitizeForLog('src/orchestrator/sanitize.ts')).toBe('src/orchestrator/sanitize.ts');
    expect(sanitizeForLog('ls -la ./repo/work')).toBe('ls -la ./repo/work');
    // "Users" という名前のディレクトリを含む相対パスを誤検知しない
    expect(sanitizeForLog('src/Users/foo.ts の型エラー')).toBe('src/Users/foo.ts の型エラー');
  });

  it('別ユーザーのホームディレクトリと前方一致するだけの無関係なパスは壊さない', () => {
    // "/home/alice" は "/home/alice2" の部分文字列だが、別ユーザーのディレクトリなので
    // 単純な前方一致では置換せず、後段の一般パターンでユーザー名だけがマスクされる
    const raw = '/home/alice2/other/file.ts';
    const result = maskHomeDir(raw, '/home/alice');
    expect(result).not.toContain('alice2');
    expect(result).toContain('/home/***/other/file.ts');
  });
});

describe('sanitizeForLog（セキュリティ監査指摘: 否定先読みによるマスク回避。MEDIUM）', () => {
  it('NixOS標準レイアウト（/var/home/<user>）でもユーザー名を露出しない', () => {
    const raw = 'at /var/home/alice/project/index.ts';
    const result = sanitizeForLog(raw);
    expect(result).not.toContain('alice');
    expect(result).toContain('/var/home/***/project/index.ts');
  });

  it('BSD系レイアウト（/usr/home/<user>）でもユーザー名を露出しない', () => {
    const raw = '/usr/home/alice/project';
    const result = sanitizeForLog(raw);
    expect(result).not.toContain('alice');
    expect(result).toContain('/usr/home/***/project');
  });

  it('Solaris/illumos系レイアウト（/export/home/<user>）でもユーザー名を露出しない', () => {
    const raw = '/export/home/alice/project';
    const result = sanitizeForLog(raw);
    expect(result).not.toContain('alice');
    expect(result).toContain('/export/home/***/project');
  });

  it('file://形式のURI（file:///home/<user>）でもユーザー名を露出しない', () => {
    const raw = 'file:///home/alice/project/index.ts';
    const result = sanitizeForLog(raw);
    expect(result).not.toContain('alice');
    expect(result).toContain('file:///home/***/project/index.ts');
  });

  it('大文字のHOMEディレクトリ（/HOME/<user>）でもユーザー名を露出しない', () => {
    const raw = '/HOME/alice/project';
    const result = sanitizeForLog(raw);
    expect(result).not.toContain('alice');
    expect(result).toContain('/HOME/***/project');
  });

  it('小文字のdrive/usersパス（C:\\users\\<user>）でもユーザー名を露出しない', () => {
    const raw = 'C:\\users\\alice\\project';
    const result = sanitizeForLog(raw);
    expect(result).not.toContain('alice');
    expect(result).toContain('C:\\users\\***\\project');
  });
});

describe('sanitizeForLog（セキュリティ監査指摘: UNCパスが対象外。LOW）', () => {
  it('UNC形式（\\\\fileserver\\Users\\<user>\\...）のローミングプロファイルでもユーザー名を露出しない', () => {
    const raw = '\\\\fileserver\\Users\\alice\\project\\index.ts';
    const result = sanitizeForLog(raw);
    expect(result).not.toContain('alice');
    expect(result).toContain('\\\\fileserver\\Users\\***\\project\\index.ts');
  });
});

describe('sanitizeForLog（iフラグ追加後も過剰マスクが起きないことの確認）', () => {
  it('大文字小文字を区別しなくても相対パスの"Users"ディレクトリは誤検知しない', () => {
    expect(sanitizeForLog('src/Users/foo.ts の型エラー')).toBe('src/Users/foo.ts の型エラー');
    expect(sanitizeForLog('SRC/USERS/foo.ts の型エラー')).toBe('SRC/USERS/foo.ts の型エラー');
  });

  it('"home"や"users"を含むが該当パターンではない通常の単語は変えない', () => {
    expect(sanitizeForLog('homework/alice/notes.md')).toBe('homework/alice/notes.md');
    expect(sanitizeForLog('income/report.csv')).toBe('income/report.csv');
  });
});

describe('maskHomeDir（Issue #378: ホームディレクトリ配下のユーザー名マスク、テスト容易性）', () => {
  it('os.homedir()相当の値と完全一致する接頭辞を~へ置換する', () => {
    expect(maskHomeDir('/home/kfuruhashi/repo/foo.ts', '/home/kfuruhashi')).toBe('~/repo/foo.ts');
  });

  it('慣習に沿わないホームディレクトリ（例: /root）でも完全一致すれば~へ置換する', () => {
    expect(maskHomeDir('/root/repo/foo.ts', '/root')).toBe('~/repo/foo.ts');
  });

  it('homeDirが空文字の場合は完全一致置換をスキップし一般パターンのみ適用する', () => {
    expect(maskHomeDir('/home/eve/repo/foo.ts', '')).toBe('/home/***/repo/foo.ts');
  });

  it('実行環境のos.homedir()に依存せず、明示的にhomeDirを渡してテストできる', () => {
    expect(maskHomeDir('/home/zzz-test-user/x', '/home/zzz-test-user')).toBe('~/x');
  });

  it('homeDirが"/"の場合は単独の"/"を全置換せず一般パターンのみ適用する（コンテナのHOME=/対策）', () => {
    // 修正前は exactHomeDirPattern が「後続が/\か文字列末尾」の単独"/"全てに一致し、
    // 末尾の区切りごと"~"へ置き換えてパスを壊していた（例: '/tmp/' → '/tmp~'）。
    expect(maskHomeDir('/tmp/', '/')).toBe('/tmp/');
  });

  it('homeDirが"/"でも/home配下のユーザー名マスク（maskHomeDirUsername）は従来通り効く', () => {
    expect(maskHomeDir('/home/eve/repo/foo.ts', '/')).toBe('/home/***/repo/foo.ts');
  });
});

describe('maskForLog（セキュリティ監査指摘: 対象範囲の明記。URLのuserinfoとホームディレクトリ配下のユーザー名のみを隠す）', () => {
  it('URLのuserinfoとホームディレクトリのユーザー名が同時に出ても両方マスクする', () => {
    const input =
      "fatal: unable to access 'https://token123@github.com/org/repo': " +
      "config read failed: open '/home/alice/.gitconfig'";
    const result = maskForLog(input, '/home/alice');
    expect(result).not.toContain('token123');
    expect(result).not.toContain('alice');
    expect(result).toContain('https://***@github.com/org/repo');
    expect(result).toContain('~/.gitconfig');
  });

  it('Bearerトークンやghp_/sk-のようなAPIキー様の文字列はマスク対象外（Issue #474で別対応）', () => {
    const input = 'Authorization: Bearer ghp_1234567890abcdefTOKEN sk-ABCDEFGHIJKLMNOP';
    expect(maskForLog(input)).toBe(input);
  });

  it('マスク対象外の値は元の文字列を変更せず返す', () => {
    const input = 'ls -la /repo/work';
    expect(maskForLog(input)).toBe(input);
  });
});

describe('stripControlChars（レビュー指摘: medium 3 / low）', () => {
  it('C0制御文字・DELを空白に畳む', () => {
    expect(stripControlChars('a\nb\tc\x00d\x7Fe')).toBe('a b c d e');
  });

  it('双方向制御文字を跡を残さず削除する', () => {
    // LRM, RLM, ALM, LRE, RLE, PDF, LRO, RLO, LRI, RLI, FSI, PDI
    const codePoints = [
      0x200e, 0x200f, 0x061c, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068,
      0x2069,
    ];
    for (const codePoint of codePoints) {
      const ch = String.fromCodePoint(codePoint);
      expect(stripControlChars('a' + ch + 'b')).toBe('ab');
    }
  });

  it('ゼロ幅文字・BOMを跡を残さず削除する（ANSIエスケープ・ゼロ幅文字が残る問題。レビュー指摘: low）', () => {
    // ZERO WIDTH SPACE, WORD JOINER, ZERO WIDTH NO-BREAK SPACE (BOM)
    const codePoints = [0x200b, 0x2060, 0xfeff];
    for (const codePoint of codePoints) {
      const ch = String.fromCodePoint(codePoint);
      expect(stripControlChars('a' + ch + 'b')).toBe('ab');
    }
  });

  it('制御文字を含まない文字列はそのまま返す', () => {
    const example = 'ls -la /repo/work';
    expect(stripControlChars(example)).toBe(example);
  });
});

describe('stripControlCharsPreservingNewlines（design.md §16.4、セキュリティ監査指摘#5）', () => {
  it('改行・タブ・復帰は保持する', () => {
    expect(stripControlCharsPreservingNewlines('a\nb\tc\rd')).toBe('a\nb\tc\rd');
  });

  it('改行・タブ・復帰以外のC0制御文字・DELは空白に畳む', () => {
    expect(stripControlCharsPreservingNewlines('a\x00b\x1Fc\x7Fd')).toBe('a b c d');
  });

  it('双方向制御文字を跡を残さず削除する（stripControlCharsと同じ、複数行を潰さない）', () => {
    // U+202E（RTL override）。不可視文字をソースへ直接書かず、コードポイントから作る
    const rtlOverride = String.fromCodePoint(0x202e);
    const spoofed = '1行目\n安全' + rtlOverride + 'exe.悪意のある名前\n3行目';
    const result = stripControlCharsPreservingNewlines(spoofed);
    expect(result).not.toContain(rtlOverride);
    // 改行はそのまま残り、3行の構造が崩れていないこと
    expect(result.split('\n')).toHaveLength(3);
  });

  it('ゼロ幅文字・BOMを跡を残さず削除する', () => {
    const codePoints = [0x200b, 0x2060, 0xfeff];
    for (const codePoint of codePoints) {
      const ch = String.fromCodePoint(codePoint);
      expect(stripControlCharsPreservingNewlines('a' + ch + 'b')).toBe('ab');
    }
  });

  it('複数行の通常テキストは改行の位置を含めてそのまま返す', () => {
    const example = '1行目のプロンプト\n\n----- 区切り -----\n本文\n----- ここまで -----';
    expect(stripControlCharsPreservingNewlines(example)).toBe(example);
  });
});
