/**
 * A question the agent has put to the user.
 *
 * This replaces the worst thing in the app: an `ask_user_question` call
 * rendered as a raw JSON blob under a "Success" badge, while the turn it
 * belonged to spun forever. See the reference screenshot.
 *
 * One card serves both sources, because to a reader they are the same
 * thing:
 *
 *  - a NATIVE pending tool, which only Aside on the desktop can answer.
 *    The options are shown but disabled, with a notice saying where to
 *    answer it -- an honest dead end beats a button that silently does
 *    nothing.
 *  - a SOFT-marker question, which sessions this app starts are instructed
 *    to use instead (see `server/src/preamble.ts`). Tapping an option
 *    sends the choice as an ordinary follow-up, which works because the
 *    agent ended its turn before asking.
 *
 * A question that has already been answered keeps its shape and shows the
 * choice, so scrolling back through a thread reads as history rather than
 * as a wall of live prompts.
 */
import { useState } from 'react';
import { Check, Spinner } from './Icons';
import { haptic } from '../telegram';
import type { QuestionBlock, QuestionItem } from '../types';

export interface QuestionCardProps {
  item: QuestionItem;
  /** Send a choice. Absent on a card that cannot be answered from here. */
  onAnswer?: (header: string, label: string) => Promise<void> | void;
  /** True while a send from this thread is in flight. */
  busy?: boolean;
}

function Options({
  block,
  disabled,
  chosen,
  onPick,
}: {
  block: QuestionBlock;
  disabled: boolean;
  chosen: string | null;
  onPick: (label: string) => void;
}) {
  if (!block.options.length) return null;
  return (
    <div className="question-options">
      {block.options.map((option) => (
        <button
          key={option.label}
          type="button"
          className={`question-option ${chosen === option.label ? 'is-chosen' : ''}`}
          disabled={disabled}
          onClick={() => onPick(option.label)}
        >
          <span className="question-option-label">
            {option.label}
            {chosen === option.label ? <Check size={13} strokeWidth={2} /> : null}
          </span>
          {option.description ? (
            <span className="question-option-description">
              {option.description}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export function QuestionCard({ item, onAnswer, busy }: QuestionCardProps) {
  /**
   * The option this client just tapped.
   *
   * Held locally so the card acknowledges the tap immediately. The
   * transcript's own record of the answer arrives a turn later and is what
   * finally settles the card (`item.status === 'answered'`); until then
   * this is the only feedback there is.
   */
  const [chosen, setChosen] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [reply, setReply] = useState('');

  const settled = item.status === 'answered';
  const live = item.answerable && !settled && Boolean(onAnswer);
  const disabled = !live || sending || Boolean(busy) || chosen !== null;

  const send = async (header: string, label: string) => {
    if (!onAnswer || disabled) return;
    haptic('light');
    setChosen(label);
    setSending(true);
    try {
      await onAnswer(header, label);
    } catch {
      // Let the reader try again rather than leaving a choice that never
      // went anywhere ticked.
      setChosen(null);
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className={`question-card ${settled ? 'is-settled' : ''} ${
        live ? '' : 'is-readonly'
      }`}
    >
      {item.questions.map((block, index) => (
        <div className="question-block" key={`${block.header}-${index}`}>
          <p className="question-header">{block.header}</p>
          <p className="question-text">{block.question}</p>
          <Options
            block={block}
            disabled={disabled}
            chosen={chosen}
            onPick={(label) => void send(block.header, label)}
          />
        </div>
      ))}

      {item.artifact ? (
        <dl className="question-artifact">
          {item.artifact.summary.map((row) => (
            <div className="question-artifact-row" key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {/*
        Free text alongside the options, because a real answer is often
        "neither of those, here is what I actually want" -- which is what
        the desktop card's own reply field is for.
      */}
      {live ? (
        <form
          className="question-reply"
          onSubmit={(event) => {
            event.preventDefault();
            const text = reply.trim();
            if (!text) return;
            setReply('');
            void send(item.questions[0]?.header || '', text);
          }}
        >
          <input
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            placeholder="Or reply in your own words"
            disabled={disabled}
            aria-label="Reply to this question"
          />
          <button type="submit" disabled={disabled || !reply.trim()}>
            {sending ? <Spinner size={13} /> : 'Send'}
          </button>
        </form>
      ) : null}

      {settled && item.answer ? (
        <p className="question-answered">{item.answer}</p>
      ) : null}

      {/*
        The honest dead end. A pending native tool has the daemon holding
        the session open for an answer over its own authenticated channel,
        and that channel is the desktop sidepanel -- verified against the
        live CLI. There is no request this app can make that would deliver
        the answer, so it says so instead of pretending.
      */}
      {!settled && !item.answerable ? (
        <p className="question-notice">
          Respond from Aside on your computer — this request can’t be
          answered from mobile.
        </p>
      ) : null}
    </div>
  );
}
