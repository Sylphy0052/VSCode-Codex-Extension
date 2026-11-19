import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Submit } from './answerForms';
import type { Bridge } from './bridge';
import { formatElapsed } from './logic';
import type {
  McHandoffDecision,
  McHandoffDetail,
  McPendingItem,
  McRepo,
  McResumeItem,
  McSession,
  McSideQuestion,
} from './protocol';

/**
 * Issue #2138の部品（引き継ぎ確認・脇道の質問・レビュー待ち・再開待ち）。app.tsxを太らせない
 * ために分けてある。外部由来のテキストは文字列として描くだけにする。
 */

/** 脇道の質問の取り直し間隔。 */
const SIDE_QUESTION_POLL_MS = 2_000;

type HandoffState =
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'error'; error: string }
  | { status: 'ok'; detail: McHandoffDetail };

/** 引き継ぎ確認の回答欄（Issue #2138の2）。選んだら中身を取り寄せ、4つの決定を送る。 */
export function HandoffForm(props: {
  item: McPendingItem;
  bridge: Bridge;
  submit: Submit;
}): JSX.Element {
  const { item, bridge } = props;
  const [state, setState] = useState<HandoffState>({ status: 'loading' });
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = (): void => {
    setState({ status: 'loading' });
    void bridge.request(item, { action: 'handoffDetail' }).then((result) => {
      if (!result.ok) {
        setState({ status: 'error', error: result.error ?? '中身を取り寄せられませんでした' });
      } else if (result.handoff === undefined) {
        setState({ status: 'none' });
      } else {
        const detail = result.handoff;
        setModel(detail.model);
        setEffort(detail.effort);
        setState({ status: 'ok', detail });
      }
    });
  };
  useEffect(load, [item.id]);

  if (state.status === 'loading') {
    return <p class="notice">中身を取り寄せ中…</p>;
  }
  if (state.status === 'none') {
    return <p class="notice">保留はありません。</p>;
  }
  if (state.status === 'error') {
    return (
      <div>
        <p class="error">{state.error}</p>
        <button type="button" class="btn" onClick={load}>
          取り寄せ直す
        </button>
      </div>
    );
  }
  const { detail } = state;
  const picked = detail.models.find((m) => m.slug === model);
  const efforts = picked?.efforts ?? [];

  const send = async (decision: McHandoffDecision): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const repick = decision === 'repick';
    const failure = await props.submit({
      action: 'handoffDecision',
      handoffRequestId: detail.requestId,
      decision,
      ...(repick ? { model } : {}),
      ...(repick && efforts.length > 0 ? { effort } : {}),
    });
    setBusy(false);
    if (failure !== undefined) {
      setError(failure);
      load();
    }
  };

  return (
    <div class="handoff-form">
      <p>
        {detail.model} / {detail.effort}（{detail.trigger}）
      </p>
      {detail.reasons.length > 0 ? (
        <ul>
          {detail.reasons.map((reason, i) => (
            <li key={i}>{reason}</li>
          ))}
        </ul>
      ) : null}
      {error === undefined ? null : (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <div class="actions">
        <button
          type="button"
          class="btn primary"
          disabled={busy}
          onClick={() => void send('proceed')}
        >
          続行
        </button>
        {detail.canReclassify ? (
          <button type="button" class="btn" disabled={busy} onClick={() => void send('reclassify')}>
            再判定
          </button>
        ) : null}
        <button type="button" class="btn" disabled={busy} onClick={() => void send('cancel')}>
          中止
        </button>
      </div>
      {detail.models.length > 0 ? (
        <div class="actions">
          <select
            aria-label="model"
            value={model}
            onChange={(e) => {
              const slug = e.currentTarget.value;
              setModel(slug);
              setEffort(detail.models.find((m) => m.slug === slug)?.efforts[0] ?? '');
            }}
          >
            {detail.models.map((m) => (
              <option key={m.slug} value={m.slug}>
                {m.label}
              </option>
            ))}
          </select>
          {efforts.length > 0 ? (
            <select
              aria-label="effort"
              value={effort}
              onChange={(e) => setEffort(e.currentTarget.value)}
            >
              {efforts.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          ) : null}
          <button
            type="button"
            class="btn"
            disabled={busy || model === ''}
            onClick={() => void send('repick')}
          >
            選び直す
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** 脇道の質問（Issue #2138の2）。本流の会話に残さず聞き、終わるまで2秒ごとに取り直す。 */
export function SideQuestionForm(props: { session: McSession; bridge: Bridge }): JSX.Element {
  const { session, bridge } = props;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [question, setQuestion] = useState<McSideQuestion | undefined>(undefined);

  const questionId = question?.id;
  const running = question?.status === 'running';
  useEffect(() => {
    if (questionId === undefined || !running) {
      return undefined;
    }
    let stopped = false;
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight) {
        return;
      }
      inFlight = true;
      void bridge
        .request(session, { action: 'sideQuestionResult', sideQuestionId: questionId })
        .then((result) => {
          inFlight = false;
          if (stopped) {
            return;
          }
          if (!result.ok) {
            setQuestion((prev) =>
              prev === undefined
                ? prev
                : {
                    ...prev,
                    status: 'failed',
                    error: result.error ?? '答えを取り寄せられませんでした',
                  },
            );
          } else if (result.sideQuestion !== undefined) {
            setQuestion(result.sideQuestion);
          }
        });
    }, SIDE_QUESTION_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [bridge, session.key, questionId, running]);

  const send = async (): Promise<void> => {
    const value = text.trim();
    if (value === '' || busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    const result = await bridge.request(session, { action: 'sideQuestion', text: value });
    setBusy(false);
    if (!result.ok || result.sideQuestion === undefined) {
      setError(result.error ?? '質問を送れませんでした');
      return;
    }
    setQuestion(result.sideQuestion);
    setText('');
  };

  return (
    <div class="side-question">
      <h3>脇道の質問（本流の会話に残さない）</h3>
      <div class="composer">
        <textarea
          rows={2}
          aria-label="脇道の質問"
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
        />
        <button
          type="button"
          class="btn"
          disabled={busy || text.trim() === ''}
          onClick={() => void send()}
        >
          聞く
        </button>
      </div>
      {error === undefined ? null : <p class="error">{error}</p>}
      {question === undefined ? null : (
        <div>
          <p class="notice">Q: {question.question}</p>
          {question.status === 'running' ? <p class="notice">考え中…</p> : null}
          {question.status === 'done' ? <p>{question.answer ?? ''}</p> : null}
          {question.status === 'failed' ? (
            <p class="error">{question.error ?? '答えを取り寄せられませんでした'}</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** レビュー待ちの行（Inboxとセッション一覧の間の節）。 */
export function ReviewSection(props: {
  sessions: readonly McSession[];
  selected: string | undefined;
  rowId: (session: McSession) => string;
  onSelect: (id: string) => void;
}): JSX.Element {
  return (
    <section class="section" aria-label="レビュー待ち">
      <h2 class="pane-title">レビュー待ち（{String(props.sessions.length)}）</h2>
      {props.sessions.length === 0 ? (
        <p class="empty">レビュー待ちの変更はありません。</p>
      ) : (
        props.sessions.map((session) => {
          const id = props.rowId(session);
          const review = session.review;
          return (
            <div
              key={session.key}
              class={props.selected === id ? 'row selected' : 'row'}
              data-row={`review:${session.key}`}
              role="option"
              aria-selected={props.selected === id}
              onClick={() => props.onSelect(id)}
            >
              <span />
              <span class="row-title">{session.title}</span>
              <span class="row-meta">
                {review === undefined
                  ? ''
                  : `${String(review.files.length)}ファイル +${String(review.added)}/-${String(review.deleted)}`}
              </span>
            </div>
          );
        })
      )}
    </section>
  );
}

/** セッション詳細の変更一覧（Issue #2138の1）。ファイルを押すとdiffを開く。 */
export function ReviewList(props: {
  session: McSession;
  bridge: Bridge;
  onToast: (message: string) => void;
}): JSX.Element | null {
  const { session, bridge } = props;
  const review = session.review;
  if (review === undefined) {
    return null;
  }
  return (
    <div class="review-list">
      <h3>変更（比較元: {review.baseLabel}）</h3>
      <div class="choices">
        {review.files.map((file) => (
          <button
            key={file.path}
            type="button"
            class="choice"
            onClick={() =>
              void bridge.openDiff(session, file.path).then((result) => {
                if (!result.ok) {
                  props.onToast(result.error ?? '差分を開けませんでした');
                }
              })
            }
          >
            <span>{file.path}</span>
            <span class="row-meta">
              {file.untracked
                ? '新規'
                : file.added === undefined || file.deleted === undefined
                  ? 'バイナリ'
                  : `+${String(file.added)}/-${String(file.deleted)}`}
            </span>
          </button>
        ))}
      </div>
      {review.truncated ? <p class="notice">ほかにもあります。</p> : null}
      <button
        type="button"
        class="btn"
        onClick={() =>
          void bridge.reviewAck(session).then((result) => {
            props.onToast(
              result.ok ? '確認済みにしました' : (result.error ?? '操作に失敗しました'),
            );
          })
        }
      >
        確認済み
      </button>
    </div>
  );
}

/** 再開待ちの行（Issue #2138の4）。 */
export function ResumeRow(props: {
  item: McResumeItem;
  repos: readonly McRepo[];
  now: number;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const { item } = props;
  return (
    <div
      class={props.selected ? 'row selected' : 'row'}
      data-row={`r:${item.id}`}
      role="option"
      aria-selected={props.selected}
      onClick={props.onSelect}
    >
      <span>再</span>
      <span class="row-title">{item.title}</span>
      <span class="row-meta">{formatElapsed(props.now - item.since)}</span>
      <span class="row-sub">
        再開待ち · {props.repos.find((r) => r.key === item.repoKey)?.label ?? ''} · {item.cwdLabel}
      </span>
    </div>
  );
}

export function ResumeDetail(props: {
  item: McResumeItem;
  now: number;
  bridge: Bridge;
  onToast: (message: string) => void;
}): JSX.Element {
  const { item, bridge } = props;
  const run = (call: Promise<{ ok: boolean; error?: string | undefined }>, done: string): void => {
    void call.then((result) => {
      props.onToast(result.ok ? done : (result.error ?? '操作に失敗しました'));
    });
  };
  return (
    <div class="detail">
      <h2>{item.title}</h2>
      <p class="notice">
        {item.cwdLabel} · {formatElapsed(props.now - item.since)}前から
      </p>
      <p>Reloadで実行中のターンが切れた会話です</p>
      <div class="actions">
        <button
          type="button"
          class="btn primary"
          onClick={() => run(bridge.resume(item), '会話を開きました')}
        >
          会話を開いて再開
        </button>
        <button
          type="button"
          class="btn"
          onClick={() => run(bridge.resumeDismiss(item), '一覧から外しました')}
        >
          一覧から外す
        </button>
      </div>
    </div>
  );
}
