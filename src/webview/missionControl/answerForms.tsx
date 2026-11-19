import type { JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';
import {
  buildPromptValues,
  buildQuestionAnswers,
  chooseOption,
  EMPTY_DRAFT,
  setOther,
  type ChoiceDraft,
} from './logic';
import type { McApprovalDetail, McControlAction, McPendingItem } from './protocol';

/**
 * Inboxの項目への回答欄（Issue #2136）。種類ごとに1つ。
 *
 * 外部由来の文字列（質問文・選択肢・コマンド）はすべてテキストノードとして描く。
 * `dangerouslySetInnerHTML`は使わない。
 */

/** キーボード操作のうち、回答欄が受け持つもの。App側が`a`/`d`/`r`/`1`〜`9`をここへ回す。 */
export interface FormKeys {
  choose(index: number): void;
  approve(): void;
  decline(): void;
  reply(): void;
}

export type FormKeysRef = { current: FormKeys | null };

export type Submit = (action: McControlAction) => Promise<string | undefined>;

interface FormProps {
  item: McPendingItem;
  keys: FormKeysRef;
  /** 回答を送る。失敗したら理由の文を返す。 */
  submit: Submit;
}

/** 送信中・失敗の表示と二重送信の防止をまとめる。 */
function useSender(submit: Submit): {
  busy: boolean;
  error: string | undefined;
  setError: (error: string | undefined) => void;
  send: (action: McControlAction) => void;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const busyRef = useRef(false);
  const send = (action: McControlAction): void => {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    void submit(action).then((failure) => {
      busyRef.current = false;
      setBusy(false);
      setError(failure);
    });
  };
  return { busy, error, setError, send };
}

function ErrorLine(props: { error: string | undefined }): JSX.Element | null {
  return props.error === undefined ? null : (
    <p class="error" role="alert">
      {props.error}
    </p>
  );
}

export function ToolApprovalForm(props: FormProps & { approval: McApprovalDetail }): JSX.Element {
  const { approval } = props;
  const { busy, error, send } = useSender(props.submit);
  const decide = (decision: 'accept' | 'decline'): void => {
    if (!approval.decidable) {
      return;
    }
    send({ action: 'approvalDecision', approvalRequestId: approval.requestId, decision });
  };
  props.keys.current = {
    choose: () => undefined,
    approve: () => decide('accept'),
    decline: () => decide('decline'),
    reply: () => undefined,
  };
  return (
    <div class="answer">
      {approval.detail === '' ? null : <pre class="pre">{approval.detail}</pre>}
      {approval.paths.length === 0 ? null : (
        <ul>
          {approval.paths.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {approval.decidable ? (
        <div class="actions">
          <button
            type="button"
            class="btn primary"
            disabled={busy}
            onClick={() => decide('accept')}
          >
            <kbd>a</kbd>承認
          </button>
          <button type="button" class="btn" disabled={busy} onClick={() => decide('decline')}>
            <kbd>d</kbd>拒否
          </button>
        </div>
      ) : (
        <p class="notice">この承認はここからは決められません。チャットタブで答えてください。</p>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

interface ChoiceListProps {
  options: Array<{ value: string; label: string; description?: string | undefined }>;
  draft: ChoiceDraft;
  multiple: boolean;
  /** 数字キーの印を出すか（いま操作中の質問だけに出す）。 */
  numbered: boolean;
  onChoose: (value: string) => void;
}

function ChoiceList(props: ChoiceListProps): JSX.Element {
  return (
    <div class="choices" role="group">
      {props.options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          class="choice"
          aria-pressed={props.draft.selected.includes(option.value)}
          onClick={() => props.onChoose(option.value)}
        >
          <span>
            {props.numbered && index < 9 ? <kbd>{String(index + 1)}</kbd> : null}
            {option.label}
          </span>
          {option.description === undefined || option.description === '' ? null : (
            <span class="choice-desc">{option.description}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** 複数の質問・欄を持つ回答欄の共通部分（下書き・操作中の質問・「その他」欄）。 */
function useDrafts(count: number): {
  drafts: ReadonlyMap<number, ChoiceDraft>;
  active: number;
  setActive: (index: number) => void;
  update: (index: number, next: ChoiceDraft) => void;
  otherRefs: { current: Array<HTMLInputElement | null> };
} {
  const [drafts, setDrafts] = useState<ReadonlyMap<number, ChoiceDraft>>(new Map());
  const [active, setActiveRaw] = useState(0);
  const otherRefs = useRef<Array<HTMLInputElement | null>>([]);
  const update = (index: number, next: ChoiceDraft): void => {
    setDrafts((prev) => new Map(prev).set(index, next));
  };
  const setActive = (index: number): void => {
    setActiveRaw(Math.min(Math.max(index, 0), Math.max(count - 1, 0)));
  };
  return { drafts, active, setActive, update, otherRefs };
}

export function QuestionForm(props: FormProps & { approval: McApprovalDetail }): JSX.Element {
  const questions = props.approval.questions ?? [];
  const { drafts, active, setActive, update, otherRefs } = useDrafts(questions.length);
  const { busy, error, setError, send } = useSender(props.submit);
  const choose = (qIndex: number, label: string): void => {
    const q = questions[qIndex];
    if (q === undefined) {
      return;
    }
    update(qIndex, chooseOption(drafts.get(qIndex) ?? EMPTY_DRAFT, label, q.multiSelect));
    setActive(qIndex);
    // 単一選択は選んだら次の質問へ進める（キーボードだけで続けて答えられるように）
    if (!q.multiSelect && qIndex + 1 < questions.length) {
      setActive(qIndex + 1);
    }
  };
  const submitAnswers = (): void => {
    const answers = buildQuestionAnswers(questions, drafts);
    if (typeof answers === 'string') {
      setError(answers);
      return;
    }
    send({ action: 'answerQuestion', pendingRequestId: props.approval.requestId, answers });
  };
  props.keys.current = {
    choose: (index) => {
      const label = questions[active]?.options[index]?.label;
      if (label !== undefined) {
        choose(active, label);
      }
    },
    approve: submitAnswers,
    decline: () => undefined,
    reply: () => otherRefs.current[active]?.focus(),
  };
  return (
    <div class="answer">
      {questions.map((q, qIndex) => {
        const draft = drafts.get(qIndex) ?? EMPTY_DRAFT;
        return (
          <div
            key={q.question}
            class={qIndex === active ? 'question active' : 'question'}
            onFocusCapture={() => setActive(qIndex)}
          >
            <h3>
              {q.header}
              {q.multiSelect ? '（複数選択）' : ''}
            </h3>
            <p class="turn-text">{q.question}</p>
            <ChoiceList
              options={q.options.map((o) => ({
                value: o.label,
                label: o.label,
                description: o.description,
              }))}
              draft={draft}
              multiple={q.multiSelect}
              numbered={qIndex === active}
              onChoose={(label) => choose(qIndex, label)}
            />
            <input
              ref={(el) => {
                otherRefs.current[qIndex] = el;
              }}
              class="text-input"
              type="text"
              placeholder="その他（自由入力）"
              aria-label={`その他: ${q.header || q.question}`}
              value={draft.other}
              onInput={(e) => update(qIndex, setOther(draft, e.currentTarget.value, q.multiSelect))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.isComposing) {
                  e.preventDefault();
                  submitAnswers();
                }
              }}
            />
          </div>
        );
      })}
      <div class="actions">
        <button type="button" class="btn primary" disabled={busy} onClick={submitAnswers}>
          <kbd>a</kbd>回答を送る
        </button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

export function PromptForm(props: FormProps & { approval: McApprovalDetail }): JSX.Element {
  const fields = props.approval.fields ?? [];
  const { drafts, active, setActive, update, otherRefs } = useDrafts(fields.length);
  const { busy, error, setError, send } = useSender(props.submit);
  const blocked = props.approval.answerBlockedReason;
  const choose = (fIndex: number, value: string): void => {
    const field = fields[fIndex];
    if (field === undefined) {
      return;
    }
    update(fIndex, chooseOption(drafts.get(fIndex) ?? EMPTY_DRAFT, value, field.multiple));
    setActive(!field.multiple && fIndex + 1 < fields.length ? fIndex + 1 : fIndex);
  };
  const submitValues = (): void => {
    if (blocked !== undefined) {
      return;
    }
    const values = buildPromptValues(fields, drafts);
    if (typeof values === 'string') {
      setError(values);
      return;
    }
    send({
      action: 'answerPrompt',
      pendingRequestId: props.approval.requestId,
      submission: { action: 'submit', values },
    });
  };
  const declinePrompt = (): void => {
    if (blocked !== undefined) {
      return;
    }
    send({
      action: 'answerPrompt',
      pendingRequestId: props.approval.requestId,
      submission: { action: 'decline', values: {} },
    });
  };
  props.keys.current = {
    choose: (index) => {
      const value = fields[active]?.options[index]?.value;
      if (value !== undefined) {
        choose(active, value);
      }
    },
    approve: submitValues,
    decline: declinePrompt,
    reply: () => otherRefs.current[active]?.focus(),
  };
  return (
    <div class="answer">
      {props.approval.detail === '' ? null : <pre class="pre">{props.approval.detail}</pre>}
      {blocked !== undefined ? (
        <p class="notice">{blocked}</p>
      ) : (
        <>
          {fields.map((field, fIndex) => {
            const draft = drafts.get(fIndex) ?? EMPTY_DRAFT;
            const free = field.options.length === 0 || field.allowOther;
            return (
              <div
                key={field.id}
                class={fIndex === active ? 'question active' : 'question'}
                onFocusCapture={() => setActive(fIndex)}
              >
                <h3>
                  {field.label || field.id}
                  {field.required ? '（必須）' : ''}
                  {field.multiple ? '（複数選択）' : ''}
                </h3>
                {field.description === '' ? null : <p class="turn-text">{field.description}</p>}
                {field.options.length === 0 ? null : (
                  <ChoiceList
                    options={field.options}
                    draft={draft}
                    multiple={field.multiple}
                    numbered={fIndex === active}
                    onChoose={(value) => choose(fIndex, value)}
                  />
                )}
                {free ? (
                  <input
                    ref={(el) => {
                      otherRefs.current[fIndex] = el;
                    }}
                    class="text-input"
                    type="text"
                    placeholder={field.options.length === 0 ? '回答' : 'その他（自由入力）'}
                    aria-label={field.label || field.id}
                    value={draft.other}
                    onInput={(e) =>
                      update(fIndex, setOther(draft, e.currentTarget.value, field.multiple))
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.isComposing) {
                        e.preventDefault();
                        submitValues();
                      }
                    }}
                  />
                ) : null}
              </div>
            );
          })}
          <div class="actions">
            <button type="button" class="btn primary" disabled={busy} onClick={submitValues}>
              <kbd>a</kbd>回答を送る
            </button>
            <button type="button" class="btn" disabled={busy} onClick={declinePrompt}>
              <kbd>d</kbd>断る
            </button>
          </div>
        </>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

export function TaskRunForm(props: FormProps): JSX.Element {
  const options = props.item.options ?? [];
  const [text, setText] = useState('');
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const { busy, error, setError, send } = useSender(props.submit);
  const submitText = (): void => {
    if (text.trim() === '') {
      setError('回答を入力するか、選択肢を選んでください');
      return;
    }
    send({ action: 'answerTaskRunQuestion', pendingId: props.item.id, text: text.trim() });
  };
  props.keys.current = {
    choose: (index) => {
      const option = options[index];
      if (option !== undefined) {
        setText(option);
      }
    },
    approve: submitText,
    decline: () => undefined,
    reply: () => textRef.current?.focus(),
  };
  return (
    <div class="answer">
      <p class="turn-text">{props.item.summary}</p>
      {options.length === 0 ? null : (
        <ChoiceList
          options={options.map((o) => ({ value: o, label: o }))}
          draft={{ selected: options.includes(text) ? [text] : [], other: '' }}
          multiple={false}
          numbered
          onChoose={setText}
        />
      )}
      <textarea
        ref={textRef}
        class="text-input"
        rows={3}
        placeholder="回答（Ctrl+Enterで送る）"
        aria-label="回答"
        value={text}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            submitText();
          }
        }}
      />
      <div class="actions">
        <button type="button" class="btn primary" disabled={busy} onClick={submitText}>
          <kbd>a</kbd>回答を送る
        </button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}
