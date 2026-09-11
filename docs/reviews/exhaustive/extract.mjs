import process from 'node:process';
import { fileURLToPath } from 'node:url';
// 読取専用の構文抽出。検査・テストの実行や精査済み判定は行わない。
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import ts from 'typescript';
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../..');
const paths = cp
  .execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const sourcePaths = paths.filter((p) => /\.(?:[cm]?[jt]s|[jt]sx|sh)$/.test(p));
const result = {
  commit: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  files: [],
};
const printer = ts.createPrinter({ removeComments: true });
function compact(s) {
  return s.replace(/\s+/g, ' ').slice(0, 220);
}
function inspect(source, file) {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
  const units = [],
    embedded = [];
  const line = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  function add(n, kind, owner, detail, outcomes) {
    units.push({
      kind,
      line: line(n.getStart(sf)),
      endLine: line(n.end),
      owner,
      detail: compact(detail),
      ...(outcomes ? { outcomes } : {}),
    });
  }
  function visit(n, owner = '<module>') {
    if (ts.isFunctionLike(n) && n.body) {
      const name =
        n.name?.getText(sf) ??
        (n.parent && (ts.isVariableDeclaration(n.parent) || ts.isPropertyAssignment(n.parent))
          ? n.parent.name.getText(sf)
          : `<${ts.SyntaxKind[n.kind]}@${line(n.getStart(sf))}>`);
      owner = owner === '<module>' ? name : owner + '/' + name;
      add(n, 'function', owner, name);
    }
    if (ts.isIfStatement(n)) add(n, 'if', owner, n.expression.getText(sf), ['true', 'false']);
    if (ts.isConditionalExpression(n))
      add(n, 'ternary', owner, n.condition.getText(sf), ['true', 'false']);
    if (ts.isCaseClause(n))
      add(n, 'case', owner, n.expression.getText(sf), ['match', 'fallthrough/break']);
    if (ts.isDefaultClause(n)) add(n, 'default', owner, 'default', ['fallback']);
    if (ts.isSwitchStatement(n) && !n.caseBlock.clauses.some(ts.isDefaultClause))
      add(n, 'switch-unmatched', owner, n.expression.getText(sf), ['no-match']);
    if (
      ts.isForStatement(n) ||
      ts.isForOfStatement(n) ||
      ts.isForInStatement(n) ||
      ts.isWhileStatement(n) ||
      ts.isDoStatement(n)
    )
      add(n, 'loop', owner, (n.condition ?? n.expression)?.getText(sf) ?? 'for(;;)', [
        'enter/repeat',
        'exit',
        'break/continue if present',
      ]);
    if (ts.isTryStatement(n))
      add(
        n,
        'try',
        owner,
        'try' + (n.catchClause ? '/catch' : '') + (n.finallyBlock ? '/finally' : ''),
        ['normal', 'exception', ...(n.finallyBlock ? ['finally'] : [])],
      );
    if (
      ts.isBinaryExpression(n) &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.AmpersandAmpersandEqualsToken,
        ts.SyntaxKind.BarBarEqualsToken,
        ts.SyntaxKind.QuestionQuestionEqualsToken,
      ].includes(n.operatorToken.kind)
    )
      add(n, 'short-circuit', owner, n.getText(sf), ['left-only', 'right-evaluated']);
    if (n.questionDotToken) add(n, 'optional', owner, n.getText(sf), ['nullish', 'value']);
    if ((ts.isParameter(n) || ts.isBindingElement(n)) && n.initializer)
      add(n, 'default-value', owner, n.getText(sf), ['undefined', 'supplied']);
    if (ts.isCallExpression(n)) {
      const expression = n.expression.getText(sf);
      if (/^(?:it|test|describe|suite)(?:\b|\.)/.test(expression))
        add(n, 'test-definition', owner, n.arguments[0]?.getText(sf) ?? expression);
      if (/^(?:expect\b|assert\b)/.test(expression)) add(n, 'assertion', owner, n.getText(sf));
    }
    if (
      (ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) &&
      source.length &&
      !file.includes('#embedded')
    ) {
      const text = ts.isNoSubstitutionTemplateLiteral(n)
        ? n.text
        : n.head.text + n.templateSpans.map((span) => '0' + span.literal.text).join('');
      const scripts = [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
      if (
        !scripts.length &&
        /(?:acquireVsCodeApi|addEventListener|function\s*(?:[\w$]+\s*)?\(|=>)/u.test(text) &&
        !/<(?:div|html|style)\b/.test(text)
      )
        scripts.push(text);
      for (const script of scripts)
        if (script.trim())
          embedded.push({
            sourceLine: line(n.getStart(sf)),
            sourceEndLine: line(n.end),
            text: script,
          });
    }
    ts.forEachChild(n, (c) => visit(c, owner));
  }
  visit(sf);
  const diagnostics = sf.parseDiagnostics.map((d) => ({
    line: line(d.start ?? 0),
    message: ts.flattenDiagnosticMessageText(d.messageText, ' '),
  }));
  return { units, embedded, diagnostics, printed: printer.printFile(sf) };
}
for (const file of sourcePaths) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const parsed = file.endsWith('.sh')
    ? { units: [], embedded: [], diagnostics: [], printed: source }
    : inspect(source, file);
  const entry = {
    path: file,
    sha256: crypto.createHash('sha256').update(source).digest('hex'),
    lines: source.split('\n').length - (source.endsWith('\n') ? 1 : 0),
    units: parsed.units,
    parseErrors: parsed.diagnostics,
    embedded: parsed.embedded.map((e, i) => ({
      sourceLine: e.sourceLine,
      sourceEndLine: e.sourceEndLine,
      ...inspect(e.text, file + '#embedded-' + i + '.js'),
      text: e.text,
    })),
  };
  result.files.push(entry);
}
fs.writeFileSync(path.join(directory, 'inventory.json'), JSON.stringify(result, null, 2) + '\n');
const totals = {};
for (const f of result.files) for (const u of f.units) totals[u.kind] = (totals[u.kind] ?? 0) + 1;
process.stdout.write(
  JSON.stringify(
    {
      files: result.files.length,
      lines: result.files.reduce((n, f) => n + f.lines, 0),
      units: totals,
      embeddedCandidates: result.files.reduce((n, f) => n + f.embedded.length, 0),
      parseErrors: result.files.filter((f) => f.parseErrors.length).map((f) => f.path),
    },
    null,
    2,
  ),
);
