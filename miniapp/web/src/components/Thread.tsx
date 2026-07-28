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
 * Only a running fold can be live, and only until the turn's answer starts
 * -- which shows up as the next item being an answer or a streaming block.
 */
export function foldIsLive(items: ThreadItem[], index: number): boolean {
  const block = items[index];
  if (block.kind !== 'work' || !block.running) return false;
  return !items
    .slice(index + 1)
    .some((item) => item.kind === 'answer' || item.kind === 'streaming');
}

export function Thread({
  items,
  sessionId,
  sources,
  subagentSteps,
  onInspectSubagent,
  onOpenCitation,
}: {
  items: ThreadItem[];
  /** Whose thread this is -- local image paths resolve against it. */
  sessionId: string;
  sources: Record<string, CitationSource>;
  subagentSteps: Record<string, ChildSteps>;
  onInspectSubagent: (childId: string, title: string) => void;
  onOpenCitation: (mark: CitationMark) => void;
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
          return (
            <div key={item.id} className="system-error">
              {item.text}
            </div>
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
