import * as vscode from 'vscode';
import type { SessionSummary } from '../codex/types';
import type { SessionActivityState } from './sessionActivity';

/**
 * 履歴ツリーの行末に出す状態デコレーション（issue #735、design.md §14.55）。
 *
 * 行の補足（`TreeItem.description`）は「CLI名・更新時刻・フォルダ名」を1本につなげた
 * 文字列で、サイドバーの幅が狭いと後ろから切れる。状態（承認待ち・実行中）は先頭へ
 * 差し込んでいるので消えにくいが、幅次第では補足そのものが出なくなる。
 * `FileDecorationProvider` が返すバッジはVS Codeが行の右端に固定で描くため、幅が
 * 狭くても切れずに残る。
 *
 * 仮想スキームのURIを使い、実ファイル（rolloutのjsonl）は指さない。実パスを指すと、
 * 同じファイルを開いているエクスプローラなど他のUIへ装飾が波及する。
 */
export const SESSION_URI_SCHEME = 'codex-session';

/** 行末のバッジを出す状態。承認待ち＞実行中＞アーカイブ済みの順で優先する。 */
export type SessionDecorationState = 'approvalPending' | 'running' | 'archived';

/**
 * 状態ごとのバッジ・色・読み上げ用の説明。
 *
 * バッジはVS Codeの仕様で2文字まで。色IDは組み込みのものだけを使う（`buildSessionIcon`
 * と同じ方針。テーマ作者が想定していない色を拡張機能側で増やさない）。
 *
 * アーカイブ済みにバッジを付けないのは、承認待ち・実行中と違って「今すぐ見るべき」
 * 合図ではないため。色を落として引っ込めるだけにする。
 */
export const SESSION_DECORATIONS: Readonly<
  Record<
    SessionDecorationState,
    { readonly badge?: string; readonly color: string; readonly tooltip: string }
  >
> = {
  approvalPending: { badge: '!', color: 'charts.yellow', tooltip: '承認待ち' },
  running: { badge: '▶', color: 'charts.blue', tooltip: '実行中' },
  archived: { color: 'descriptionForeground', tooltip: 'アーカイブ済み' },
};

/** セッションへ振る仮想URI。`codex-session:/<provider>/<id>`。 */
export function sessionUri(session: Pick<SessionSummary, 'provider' | 'id'>): vscode.Uri {
  return vscode.Uri.from({
    scheme: SESSION_URI_SCHEME,
    // idにスラッシュが入っても壊れないようにエンコードする（rolloutのidはUUIDだが、
    // プロバイダが増えたときに前提が変わりうる）
    path: `/${encodeURIComponent(session.provider)}/${encodeURIComponent(session.id)}`,
  });
}

/** `sessionUri` の逆。このスキーム以外・形が違うURIには`undefined`を返す。 */
export function parseSessionUri(
  uri: Pick<vscode.Uri, 'scheme' | 'path'>,
): { provider: string; id: string } | undefined {
  if (uri.scheme !== SESSION_URI_SCHEME) {
    return undefined;
  }
  const segments = uri.path.split('/');
  // 先頭のスラッシュで空要素が1つ入るため、['', provider, id] の3つになる
  const provider = segments[1];
  const id = segments[2];
  if (
    segments.length !== 3 ||
    provider === undefined ||
    provider === '' ||
    id === undefined ||
    id === ''
  ) {
    return undefined;
  }
  return { provider: decodeURIComponent(provider), id: decodeURIComponent(id) };
}

/**
 * 状態の決定。アイコン（`buildSessionIcon`）と同じ優先順位にする。
 *
 * 承認待ち・実行中はアーカイブ済みより優先する。アーカイブ済みのセッションを開き直して
 * 動かしている最中に「アーカイブ済み」だけが出ると、動いていることが読めなくなる。
 */
export function decorationStateOf(
  session: Pick<SessionSummary, 'archived'>,
  activity: SessionActivityState | undefined,
): SessionDecorationState | undefined {
  if (activity === 'approvalPending') {
    return 'approvalPending';
  }
  if (activity === 'running') {
    return 'running';
  }
  return session.archived === true ? 'archived' : undefined;
}

/**
 * デコレーションの引き先。`SessionTreeProvider` がこの形を満たす。
 *
 * 依存の向きをツリー→装飾の一方向にするため、装飾側がツリーの更新イベントを購読する。
 * ツリー側から装飾を突く形にすると、両方が互いを持つ配線になる。
 */
export interface SessionDecorationSource {
  readonly onDidChangeTreeData: vscode.Event<void>;
  decorationStateFor(uri: vscode.Uri): SessionDecorationState | undefined;
}

/**
 * 履歴ツリーの行へバッジ・色を返す。
 *
 * 状態は保持せず、問い合わせのたびにツリー側へ引く。キャッシュを持つと、ツリーの更新と
 * 装飾の更新がずれたときに古いバッジが残る。
 */
export class SessionDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly source: SessionDecorationSource) {
    // ツリーが変わったら全URIの装飾を引き直させる（どの行が変わったかはツリー側も
    // 持っていないため、URIを絞らず`undefined`で全体を無効化する）
    this.subscription = source.onDidChangeTreeData(() => {
      this.emitter.fire(undefined);
    });
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const state = this.source.decorationStateFor(uri);
    if (state === undefined) {
      return undefined;
    }
    const spec = SESSION_DECORATIONS[state];
    const decoration = new vscode.FileDecoration(
      spec.badge,
      spec.tooltip,
      new vscode.ThemeColor(spec.color),
    );
    // 色は形（バッジ）の補助。バッジを持たないアーカイブ済みでも、行の文字色だけは
    // 落とす（`propagate`は付けない。親のグループ見出しまで色が伝播すると、
    // グループ内に1件でもアーカイブ済みがあるだけで見出しが沈む）
    return decoration;
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
