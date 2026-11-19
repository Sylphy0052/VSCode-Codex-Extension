import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { Bridge, ControlResult } from './bridge';
import type {
  McApprovalLevel,
  McSession,
  McSessionSettings,
  McSettingChangeAction,
} from './protocol';

/** 承認レベルの表示名（`src/provider/approvalLevel.ts`の`APPROVAL_LEVEL_LABELS`と同じ語）。 */
const APPROVAL_LABELS: Record<McApprovalLevel, string> = {
  ask: '全確認',
  auto: '自動判定',
  full: '全承認',
};
const APPROVAL_LEVELS: readonly McApprovalLevel[] = ['ask', 'auto', 'full'];

/** 承認レベルの変更が効く範囲の説明（Issue #2159）。 */
const SCOPE_LABELS: Record<McSessionSettings['approvalScope'], string> = {
  session: 'このセッションだけ',
  global: 'Codex全体の設定（タスク設定の無いCodexセッションすべての次のターンに効く）',
  task: 'タスクの設定で固定（変えられない）',
};

/** plan / fast modeの切り替えは通知で状態が変わるため、少し待ってから読み直す。 */
const REFETCH_AFTER_MS = 1_500;

function isApprovalLevel(value: string): value is McApprovalLevel {
  return (APPROVAL_LEVELS as readonly string[]).includes(value);
}

function labelOfModel(settings: McSessionSettings, slug: string): string {
  return settings.models.find((m) => m.slug === slug)?.label ?? (slug === '' ? '既定' : slug);
}

/**
 * 詳細ペインの設定欄（Issue #2159）。選んでいるセッションの今のmodel・effort・承認レベル・
 * plan / fast modeを出し、変える。model・effort・承認レベルは選んでから「変更する」
 * （Ctrl+Enter）でまとめて送る。↑ / ↓で選ぶたびに送らないため。
 */
export function SessionSettingsPanel(props: {
  session: McSession;
  bridge: Bridge;
  onToast: (message: string) => void;
}): JSX.Element {
  const { session, bridge } = props;
  const [settings, setSettings] = useState<McSessionSettings | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [approval, setApproval] = useState('');
  const [reload, setReload] = useState(0);
  // 読み直しで選択欄を上書きするかの判断に使う、直前に受け取った設定とそのセッション
  const adopted = useRef<{ key: string; settings: McSessionSettings } | undefined>(undefined);

  /**
   * 受け取った設定を出す。同じセッションの読み直しでは、人が選び替えて未送信の欄は残し、
   * 選び替えていない欄だけ新しい値へ合わせる。
   */
  const adopt = (next: McSessionSettings): void => {
    const previous = adopted.current?.key === session.key ? adopted.current.settings : undefined;
    adopted.current = { key: session.key, settings: next };
    setSettings(next);
    if (previous === undefined) {
      setModel(next.model);
      setEffort(next.effort);
      setApproval(next.approvalLevel);
      return;
    }
    setModel((current) => (current === previous.model ? next.model : current));
    setEffort((current) => (current === previous.effort ? next.effort : current));
    setApproval((current) => (current === previous.approvalLevel ? next.approvalLevel : current));
  };

  // 別のセッションへ移ったら、前のセッションの設定を出したまま操作させない
  useEffect(() => {
    if (adopted.current !== undefined && adopted.current.key !== session.key) {
      adopted.current = undefined;
      setSettings(undefined);
      setError(undefined);
    }
  }, [session.key]);

  useEffect(() => {
    let stopped = false;
    void bridge.request(session, { action: 'sessionSettings' }).then((result) => {
      if (stopped) {
        return;
      }
      if (result.ok && result.settings !== undefined) {
        adopt(result.settings);
        setError(undefined);
      } else if (adopted.current?.key !== session.key) {
        setSettings(undefined);
        setError(result.error ?? '設定を取り寄せられませんでした');
      }
    });
    return () => {
      stopped = true;
    };
    // セッションが変わったとき・変更の後・セッションの動き（ターンの開始と終わり、modelの表示）が
    // 変わったときに読み直す。Claudeの承認レベルやplan / fast modeはCLIの通知で確定し、
    // タブ側で変えた値もここへは届かないため、取り寄せ直さないと古い値を出し続ける
  }, [bridge, session.key, reload, session.activity, session.activitySince, session.model]);

  if (settings === undefined) {
    return (
      <div class="session-settings">
        <h3>設定</h3>
        {error === undefined ? <p class="notice">読み込み中…</p> : <p class="error">{error}</p>}
      </div>
    );
  }

  const send = async (change: McSettingChangeAction): Promise<ControlResult> => {
    const result = await bridge.request(session, change);
    if (result.settings !== undefined) {
      adopt(result.settings);
    }
    return result;
  };

  const apply = async (): Promise<void> => {
    if (busy) {
      return;
    }
    // 先にmodelを変える。effortは変更後のmodelで選べる値かを受信側が確かめる
    const changes: McSettingChangeAction[] = [];
    if (model !== settings.model) {
      changes.push({ action: 'changeSetting', setting: 'model', value: model });
    }
    if (effort !== settings.effort) {
      changes.push({ action: 'changeSetting', setting: 'effort', value: effort });
    }
    if (approval !== settings.approvalLevel && isApprovalLevel(approval)) {
      changes.push({ action: 'changeSetting', setting: 'approvalLevel', value: approval });
    }
    if (changes.length === 0) {
      props.onToast('変わった設定はありません');
      return;
    }
    setBusy(true);
    setError(undefined);
    // Claudeの承認レベルは、CLIが新しい値を通知するまで応答に前の値が載る。少し待って読み直す
    const refetchLater = (): void => {
      setTimeout(() => setReload((n) => n + 1), REFETCH_AFTER_MS);
    };
    for (const change of changes) {
      const result = await send(change);
      if (!result.ok) {
        setError(result.error ?? '設定を変えられませんでした');
        setBusy(false);
        refetchLater();
        return;
      }
    }
    setBusy(false);
    props.onToast('設定を変えました。次のターンから効きます');
    refetchLater();
  };

  const toggle = async (setting: 'planMode' | 'fastMode', value: boolean): Promise<void> => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    const result = await send({ action: 'changeSetting', setting, value });
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? '切り替えられませんでした');
      return;
    }
    props.onToast(`${setting === 'planMode' ? 'Plan mode' : 'Fast mode'}の切り替えを送りました`);
    // 状態はCLIの通知で変わる。少し待ってから読み直す
    setTimeout(() => setReload((n) => n + 1), REFETCH_AFTER_MS);
  };

  const disabled = busy || !settings.editable;
  const efforts = settings.models.find((m) => m.slug === model)?.efforts ?? [];
  const approvalLocked = disabled || settings.approvalScope === 'task';
  const summary = [
    `model: ${labelOfModel(settings, settings.model)}`,
    `effort: ${settings.effort === '' ? '既定' : settings.effort}`,
    `承認: ${isApprovalLevel(settings.approvalLevel) ? APPROVAL_LABELS[settings.approvalLevel] : 'カスタム'}（${SCOPE_LABELS[settings.approvalScope]}）`,
    `plan: ${settings.planMode ? 'ON' : 'OFF'}`,
    ...(settings.fastMode === undefined ? [] : [`fast: ${settings.fastMode ? 'ON' : 'OFF'}`]),
  ];
  return (
    <div class="session-settings" data-submit-scope>
      <h3>設定</h3>
      <p class="notice" data-settings-summary>
        {summary.join(' · ')}
      </p>
      {settings.editable ? null : (
        <p class="notice">入力欄を閉じたタブのため、設定は見るだけです。</p>
      )}
      <div class="launch-row">
        <select
          aria-label="model"
          data-settings-first
          value={model}
          disabled={disabled}
          onChange={(e) => {
            const slug = e.currentTarget.value;
            setModel(slug);
            const allowed = settings.models.find((m) => m.slug === slug)?.efforts ?? [];
            if (effort !== '' && !allowed.includes(effort)) {
              setEffort('');
            }
          }}
        >
          {settings.models.map((m) => (
            <option key={m.slug} value={m.slug}>
              {m.label}
            </option>
          ))}
        </select>
        <select
          aria-label="effort"
          value={effort}
          disabled={disabled || efforts.length === 0}
          onChange={(e) => setEffort(e.currentTarget.value)}
        >
          <option value="">既定</option>
          {efforts.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select
          aria-label={`承認レベル（${SCOPE_LABELS[settings.approvalScope]}）`}
          value={approval}
          disabled={approvalLocked}
          onChange={(e) => setApproval(e.currentTarget.value)}
        >
          {isApprovalLevel(settings.approvalLevel) ? null : <option value="">カスタム</option>}
          {APPROVAL_LEVELS.map((level) => (
            <option key={level} value={level}>
              {APPROVAL_LABELS[level]}
            </option>
          ))}
        </select>
        <button
          type="button"
          class="btn primary"
          disabled={disabled}
          onClick={() => void apply()}
          data-submit
        >
          設定を変更する
        </button>
      </div>
      {settings.approvalScope === 'global' ? (
        <p class="notice">承認レベルはCodex全体の設定です。ほかのCodexセッションにも効きます。</p>
      ) : null}
      <div class="actions">
        <button
          type="button"
          class="btn"
          data-settings-plan
          disabled={disabled}
          onClick={() => void toggle('planMode', !settings.planMode)}
        >
          {settings.planMode ? 'Plan modeを抜ける' : 'Plan modeに入る'}
        </button>
        {settings.fastMode === undefined ? null : (
          <button
            type="button"
            class="btn"
            data-settings-fast
            disabled={disabled}
            onClick={() => void toggle('fastMode', settings.fastMode !== true)}
          >
            {settings.fastMode ? 'Fast modeをOFFにする' : 'Fast modeをONにする'}
          </button>
        )}
      </div>
      {error === undefined ? null : (
        <p class="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
