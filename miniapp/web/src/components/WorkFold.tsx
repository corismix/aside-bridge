/**
 * The step timeline, and the `Worked for 39m 8s ›` fold it settles into.
 *
 * The desktop app shows work as it happens: while the turn runs the steps
 * are on the page, one line each, spinners on the ones still in flight.
 * Only when the final answer starts arriving does the whole history fold
 * away into a single quiet row. That is what `live` selects between here --
 * a finished turn opens collapsed, exactly as before.
 *
 * A step can expand into its own detail. File writes and subagent spawns
 * get purpose-built cards; every other tool keeps the generic command and
 * output card. There are no per-step timestamps anywhere: the sidepanel
 * shows none.
 */
import { useState } from 'react';
import type {
  ChildSteps,
  CitationSource,
  FileEdit,
  WorkBlock,
  WorkStep,
} from '../types';
import { workedFor } from '../utils/time';
import { ChevronDown, ChevronRight, Spinner, StepGlyph } from './Icons';
import { Markdown } from './Markdown';
import { FileCard } from './FileCard';
import { SubagentCard } from './SubagentCard';
import { haptic } from '../telegram';
import type { CitationMark } from '../utils/citations';

const OUTPUT_CLAMP = 600;

export interface WorkFoldProps {
  block: WorkBlock;
  /** Whose thread this is -- local image paths resolve against it. */
  sessionId: string;
  /** True while this turn is still working and no answer has begun. */
  live: boolean;
  subagentSteps: Record<string, ChildSteps>;
  onInspectSubagent: (childId: string, title: string) => void;
  sources: Record<string, CitationSource>;
  onOpenCitation: (mark: CitationMark) => void;
}

function ToolDetail({ step }: { step: WorkStep }) {
  const [showAll, setShowAll] = useState(false);
  const output = step.detail?.output || '';
  const clamped = !showAll && output.length > OUTPUT_CLAMP;
  const shown = clamped ? output.slice(0, OUTPUT_CLAMP) : output;

  return (
    <div className="tool-card">
      <div className="tool-card-head">
        <StepGlyph icon={step.icon} size={13} />
        <span className="tool-card-title">{step.label}</span>
        <span className={`badge ${step.status === 'error' ? 'is-error' : ''}`}>
          {step.status === 'error' ? 'Error' : 'Success'}
        </span>
      </div>
      <div className="tool-card-body">
        {step.detail?.command ? (
          <pre className="tool-command">
            <span className="tool-prompt">$</span> {step.detail.command}
          </pre>
        ) : null}
        {shown ? <pre className="tool-output">{shown}</pre> : null}
        {clamped || (step.detail?.truncated && !showAll) ? (
          <button
            type="button"
            className="show-more"
            onClick={() => setShowAll(true)}
          >
            Show more
          </button>
        ) : null}
        {step.detail?.truncated && showAll ? (
          <p className="tool-note">Output truncated by the server.</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A file write or edit.
 *
 * The card stays open while the write is in flight, which is how the
 * desktop app shows one landing, and folds to its row once the result
 * arrives -- unless the reader has opened it themselves since.
 */
function FileStep({ step, file }: { step: WorkStep; file: FileEdit }) {
  const writing = step.status === 'pending';
  const [pinned, setPinned] = useState<boolean | null>(null);
  const shown = pinned ?? writing;
  // In flight the row names what is happening; afterwards the built label
  // ("Wrote …", "Edited …") already reads correctly.
  const label = writing
    ? `${file.mode === 'write' ? 'Writing' : 'Editing'} ${file.name}`
    : step.label;

  return (
    <div className="step">
      <button
        type="button"
        className="step-row is-expandable"
        onClick={() => setPinned(!shown)}
      >
        <span className="step-icon">
          {writing ? <Spinner size={14} /> : <StepGlyph icon={step.icon} />}
        </span>
        <span className="step-label">{label}</span>
        {step.diffstat ? (
          <span className="diffstat">
            <span className="added">+{step.diffstat.added}</span>{' '}
            <span className="removed">-{step.diffstat.removed}</span>
          </span>
        ) : null}
        <span className="step-chevron">
          {shown ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>
      {shown ? <FileCard file={file} /> : null}
    </div>
  );
}

function StepRow({ step }: { step: WorkStep }) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(step.detail?.command || step.detail?.output);

  return (
    <div className="step">
      <button
        type="button"
        className={`step-row ${expandable ? 'is-expandable' : ''}`}
        onClick={() => expandable && setOpen((prev) => !prev)}
      >
        <span className="step-icon">
          {step.status === 'pending' ? (
            <Spinner size={14} />
          ) : (
            <StepGlyph icon={step.icon} />
          )}
        </span>
        <span className="step-label">{step.label}</span>
        {step.diffstat ? (
          <span className="diffstat">
            <span className="added">+{step.diffstat.added}</span>{' '}
            <span className="removed">-{step.diffstat.removed}</span>
          </span>
        ) : null}
        {expandable ? (
          <span className="step-chevron">
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
        ) : null}
      </button>

      {step.images.length || step.imagesDropped ? (
        <div className="step-shots">
          {step.images.map((src, index) => (
            <img key={index} src={src} alt="" loading="lazy" />
          ))}
          {/* The server caps inline images; saying so beats quietly showing
              fewer than the tool produced. */}
          {step.imagesDropped ? (
            <p className="step-shots-note">
              {step.imagesDropped} more image
              {step.imagesDropped === 1 ? '' : 's'} not shown
            </p>
          ) : null}
        </div>
      ) : null}

      {open ? <ToolDetail step={step} /> : null}
    </div>
  );
}

function Timeline({
  block,
  sessionId,
  subagentSteps,
  onInspectSubagent,
  sources,
  onOpenCitation,
}: WorkFoldProps) {
  return (
    <div className="timeline">
      {block.items.map((item) => {
        if (item.kind !== 'step') {
          return (
            <div key={item.id} className="timeline-text">
              <Markdown
                text={item.text}
                sources={sources}
                sessionId={sessionId}
                onOpenCitation={onOpenCitation}
              />
            </div>
          );
        }
        if (item.subagent) {
          return (
            <SubagentCard
              key={item.id}
              spawn={item.subagent}
              steps={
                item.subagent.child
                  ? subagentSteps[item.subagent.child.id]
                  : undefined
              }
              onInspect={onInspectSubagent}
            />
          );
        }
        if (item.file) {
          return <FileStep key={item.id} step={item} file={item.file} />;
        }
        return <StepRow key={item.id} step={item} />;
      })}
    </div>
  );
}

export function WorkFold(props: WorkFoldProps) {
  const { block, live } = props;
  // Null means "follow the turn": open while it works, folded once the
  // answer starts. An explicit tap pins it either way.
  const [pinned, setPinned] = useState<boolean | null>(null);
  const open = pinned ?? live;

  const lastStep = [...block.items]
    .reverse()
    .find((item): item is WorkStep => item.kind === 'step');

  return (
    <div className={`fold ${open ? 'is-open' : ''} ${live ? 'is-live' : ''}`}>
      <button
        type="button"
        className="fold-row"
        onClick={() => {
          haptic('light');
          setPinned(!open);
        }}
      >
        {block.running ? (
          <>
            <Spinner size={13} />
            <span className="fold-label">
              {lastStep ? lastStep.label : 'Working…'}
            </span>
          </>
        ) : (
          <span className="fold-label">
            Worked for {workedFor(block.durationMs)}
          </span>
        )}
        <span className="fold-chevron">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>

      {open ? <Timeline {...props} /> : null}
    </div>
  );
}
