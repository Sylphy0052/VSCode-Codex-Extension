import type { JSX } from 'preact';
import type { McCardStatus } from './logic';
import type { McPendingKind, McProvider } from './protocol';

/** インラインSVGのアイコン（Issue #2136の7）。色は`currentColor`でテーマに従う。 */
function Svg(props: { label: string; children: JSX.Element | JSX.Element[] }): JSX.Element {
  return (
    <svg class="icon" viewBox="0 0 16 16" role="img" aria-label={props.label}>
      <title>{props.label}</title>
      {props.children}
    </svg>
  );
}

const KIND_PATHS: Record<McPendingKind, JSX.Element[]> = {
  // 盾（承認）
  toolApproval: [<path key="a" d="M8 1.5 13 3.5v4c0 3.2-2.2 5.6-5 7-2.8-1.4-5-3.8-5-7v-4z" />],
  // 疑問符（質問）
  askUserQuestion: [
    <circle key="a" cx="8" cy="8" r="6.5" />,
    <path key="b" d="M6.2 6.2a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.6" />,
    <path key="c" d="M8 11.6v.1" />,
  ],
  // 吹き出し（Codexの質問）
  codexPrompt: [
    <path key="a" d="M2 3h12v8H7l-3 2.5V11H2z" />,
    <path key="b" d="M5 6.5h6M5 8.5h4" />,
  ],
  // チェックリスト（ワークフロー承認）
  workflowApproval: [
    <path key="a" d="M2.5 4.5l1.2 1.2 2-2M2.5 10.5l1.2 1.2 2-2" />,
    <path key="b" d="M8 4.5h5.5M8 10.5h5.5" />,
  ],
  // 階層（task run）
  taskRunQuestion: [
    <rect key="a" x="2" y="2" width="5" height="4" />,
    <rect key="b" x="9" y="10" width="5" height="4" />,
    <path key="c" d="M4.5 6v6H9" />,
  ],
  // 矢印（引き継ぎ）
  handoff: [<path key="a" d="M2 8h11M9.5 4.5 13 8l-3.5 3.5" />],
};

export function KindIcon(props: { kind: McPendingKind; label: string }): JSX.Element {
  return <Svg label={props.label}>{KIND_PATHS[props.kind]}</Svg>;
}

/**
 * 状態ごとに形の違うアイコン（Issue #2151）。色だけに頼らず形でも見分けられるようにする。
 * 実行中は回る弧（スピナー。`prefers-reduced-motion`では止まり、弧の形だけが残る）。
 */
const STATUS_PATHS: Record<McCardStatus, JSX.Element[]> = {
  // 回る弧（実行中）
  running: [
    <circle key="a" cx="8" cy="8" r="5.5" class="status-track" />,
    <path key="b" d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" />,
  ],
  // 弧と中心の点（バックグラウンドで実行中）
  backgroundRunning: [
    <path key="a" d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" />,
    <circle key="b" cx="8" cy="8" r="1.4" class="status-fill" />,
  ],
  // 三角の感嘆符（停滞）
  stalled: [<path key="a" d="M8 2 14.5 13.5h-13z" />, <path key="b" d="M8 6.5v3.2M8 11.6v.1" />],
  // 円の感嘆符（入力待ち）
  approvalPending: [
    <circle key="a" cx="8" cy="8" r="6" />,
    <path key="b" d="M8 4.8v3.8M8 11v.1" />,
  ],
  // 矢印（引き継ぎ確認）
  handoffPending: [<path key="a" d="M2.5 8h10M9.5 4.5 13 8l-3.5 3.5" />],
  // 中抜きの丸（待機）
  idle: [<circle key="a" cx="8" cy="8" r="4" />],
};

/** `decorative`は隣に同じ文言があるとき（ピルの中など）。読み上げを重ねないよう隠す。 */
export function StatusIcon(props: {
  status: McCardStatus;
  label: string;
  decorative?: boolean;
}): JSX.Element {
  const className = `icon status-icon status-${props.status}`;
  if (props.decorative === true) {
    return (
      <svg class={className} viewBox="0 0 16 16" aria-hidden="true">
        {STATUS_PATHS[props.status]}
      </svg>
    );
  }
  return (
    <svg class={className} viewBox="0 0 16 16" role="img" aria-label={props.label}>
      <title>{props.label}</title>
      {STATUS_PATHS[props.status]}
    </svg>
  );
}

export function ProviderIcon(props: { provider: McProvider }): JSX.Element {
  return props.provider === 'claude' ? (
    <Svg label="Claude Code">
      <path d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2" />
    </Svg>
  ) : (
    <Svg label="Codex">
      <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />
    </Svg>
  );
}
