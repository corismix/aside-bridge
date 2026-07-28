/**
 * A thread, drawn the way the sidepanel draws one.
 *
 * User messages are light grey rounded bubbles. The assistant's answer is
 * plain markdown on the page background -- no bubble, no card, no avatar.
 *
 * Work is the interesting part. While a turn is running its steps are on
 * the page, live; the moment the final answer starts arriving they fold
 * into a single `Worked for …` row above it. `foldIsLive` below is that
 * rule: a running fold stays open until either the streamed answer has
 * begun or the transcript has already promoted an answer out of it. Mid-turn
 * commentary does not trigger it, because commentary is followed by more
 * tool calls, which clears the stream buffer and reopens the timeline.
 *
 * Two of these items never come from the transcript:
 *
 *  - a `pending` user bubble, appended the moment Send is tapped so the
 *    message is visible immediately, and dimmed until the transcript
 *    confirms it;
 *  - a `streaming` block, the answer as the CLI is writing it. It goes
 *    through the same markdown renderer as the finished answer so there is
 *    no reflow when the two swap.
 */
import type {
  Attachment,
  ChildSteps,
  CitationSource,
  ThreadItem,
} from '../types';
import { FileIcon } from './Icons';
import { Markdown } from './Markdown';
import { WorkFold } from './WorkFold';
import { ErrorCard } from './ErrorCard';
import { QuestionCard } from './QuestionCard';
import type { CitationMark } from '../utils/citations';

function BubbleAttachments({ files }: { files: Attachment[] }) {
  return (
    <span className="bubble-files">
      {files.map((file, index) => (
        <span className="bubble-file" key={`${file.name}-${index}`}>
          <FileIcon size={12} strokeWidth={1.75} />
          {file.name}
        </span>
      ))}
    </span>
  );
}

/**
 * Whether the fold at `index` should still be showing its timeline.
 *
 * The rule, and the bug it replaces.
 *
 * The old rule was "live until any answer or streaming item follows". That
 * looks right and is not, because a `streaming` item is just whatever the
 * CLI has written to stdout -- and the agent narrates MID-TURN, between
 * tool calls, all the time. Every paragraph of commentary therefore
 * collapsed the timeline; the next tool call cleared the stream buffer and
 * re-opened it. On a chatty turn that is a fold flapping open and shut
 * several times a minute, which is exactly the reported "doesn't reliably
 * auto-expand, collapse is flaky".
 *
 * What actually distinguishes commentary from the final answer is whether
 * the agent is still doing anything. Commentary is followed by more work,
 * so a step in the block is still pending; the final answer only starts
 * once every step has its result. So:
 *
 *  - not running          -> not live (a finished turn opens collapsed)
 *  - a real `answer` item -> not live (the transcript has settled it)
 *  - streaming text while a step is still in flight -> LIVE (commentary)
 *  - streaming text with every step settled          -> not live (answer)
 *
 * Exported and tested directly; it is a state machine, not a detail.
 */
export function foldIsLive(items: ThreadItem[], index: number): boolean {
  const block = items[index];
  if (block.kind !== 'work' || !block.running) return false;

  const after = items.slice(index + 1);
  // The transcript has promoted an answer out of this turn: it is over.
  if (after.some((item) => item.kind === 'answer')) return false;
  // A question ends the turn too -- the card below is the point of it.
  if (after.some((item) => item.kind === 'question')) return false;

  if (!after.some((item) => item.kind === 'streaming')) return true;

  // Streaming, so decide whether it is commentary or the answer.
  return block.items.some(
    (item) => item.kind === 'step' && item.status === 'pending',
  );
}

export function Thread({
  items,
  sessionId,
  sources,
  subagentSteps,
  onInspectSubagent,
  onOpenCitation,
  onAnswer,
  busy,
}: {
  items: ThreadItem[];
  /** Whose thread this is -- local image paths resolve against it. */
  sessionId: string;
  sources: Record<string, CitationSource>;
  subagentSteps: Record<string, ChildSteps>;
  onInspectSubagent: (childId: string, title: string) => void;
  onOpenCitation: (mark: CitationMark) => void;
  /** Send a question's chosen option as a follow-up message. */
  onAnswer?: (header: string, label: string) => Promise<void>;
  /** A send is in flight, so question cards hold their buttons. */
  busy?: boolean;
}) {
  return (
    <div className="thread">
      {items.map((item, index) => {
        if (item.kind === 'user') {
          return (
            <div
              key={item.id}
              className={`user-bubble ${item.pending ? 'is-pending' : ''}`}
            >
              {item.attachments?.length ? (
                <BubbleAttachments files={item.attachments} />
              ) : null}
              {item.text}
            </div>
          );
        }
        if (item.kind === 'work') {
          return (
            <WorkFold
              key={item.id}
              block={item}
              sessionId={sessionId}
              live={foldIsLive(items, index)}
              subagentSteps={subagentSteps}
              onInspectSubagent={onInspectSubagent}
              sources={sources}
              onOpenCitation={onOpenCitation}
            />
          );
        }
        if (item.kind === 'error') {
          return <ErrorCard key={item.id} alert={item.alert} />;
        }
        if (item.kind === 'question') {
          return (
            <QuestionCard
              key={item.id}
              item={item}
              busy={busy}
              onAnswer={onAnswer}
            />
          );
        }
        return (
          <div key={item.id} className="answer">
            <Markdown
              text={item.text}
              streaming={item.kind === 'streaming'}
              sources={sources}
              sessionId={sessionId}
              onOpenCitation={onOpenCitation}
            />
          </div>
        );
      })}
    </div>
  );
}
