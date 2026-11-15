// 自己改善PR（ラベル self-improve）が保護パスに触れていたら失敗させる（Issue #2082）。
// 拡張側のmerge判定（src/orchestrator/selfImproveGuard.ts）を自己改変で外されても止まるよう、CIでも検査する。
// 使い方: node scripts/check-self-improve-protected.mjs <baseRef> <headRef>
// 環境変数PR_LABELSにPRのラベル名をカンマ区切りで渡す。保護パスの一覧はPR側ではなく<baseRef>のものを使う。
import { execFileSync } from 'node:child_process';

const LIST_FILE = '.github/self-improve-protected-paths';
const LABEL = 'self-improve';

const [base, head] = process.argv.slice(2);
if (!base || !head) {
  console.error('usage: check-self-improve-protected.mjs <baseRef> <headRef>');
  process.exit(2);
}
const labels = (process.env.PR_LABELS ?? '')
  .split(',')
  .map((l) => l.trim())
  .filter(Boolean);
if (!labels.includes(LABEL)) {
  console.log(`ラベル${LABEL}が無いので検査しない`);
  process.exit(0);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const patterns = git('show', `${base}:${LIST_FILE}`)
  .split(/\r?\n/u)
  .map((l) => l.trim())
  .filter((l) => l !== '' && !l.startsWith('#'));

function toRegExp(pattern) {
  const body = pattern.endsWith('/') ? `${pattern}**` : pattern;
  let source = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '*') {
      if (body[i + 1] === '*') {
        source += '.*';
        i += 1;
      } else {
        source += '[^/]*';
      }
    } else {
      source += ch.replace(/[.+?^${}()|[\]\\]/gu, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'u');
}

const regexps = patterns.map(toRegExp);
const files = git('diff', '--name-only', '--no-renames', `${base}...${head}`)
  .split('\n')
  .filter(Boolean);
const touched = files.filter((f) => regexps.some((re) => re.test(f)));
if (touched.length > 0) {
  console.error(`自己改善PRが保護パスに触れている:\n${touched.map((f) => `  ${f}`).join('\n')}`);
  console.error('保護パスの変更は自律では作らず、調査Issueのチェックリストへ提案として残す。');
  process.exit(1);
}
console.log('保護パスへの変更なし');
