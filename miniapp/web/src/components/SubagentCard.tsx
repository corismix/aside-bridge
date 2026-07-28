import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ProviderMark,
  Spinner,
  StepGlyph,
} from './Icons';
import { Creature } from './Creature';
import { haptic } from '../telegram';
import type { ChildSteps, SubagentSpawn, WorkStep } from '../types';

/** How many of a subagent's steps the card shows before summarising. */
const VISIBLE_STEPS = 4;

/**
 * A spawned subagent, drawn the way the desktop app draws it: a `Spawned …`
 * row with the creature's colour, and under it a nested card with the
 * agent's model, its status, the first line of its brief, and its own tool
 * timeline ticking over live.
 *
 * The card is open by default while the subagent is running -- that is the
 * moment it is worth watching -- and can be folded away once it is done.
 * Tapping the header opens the child's own thread.
 */
export function SubagentCard({
  spawn,
  steps,
  onInspect,
}: {
  spawn: SubagentSpawn;
  steps: ChildSteps | undefined;
  onInspect: (childId: string, title: string) => void;
}) {
  const child = spawn.child;
  const running = Boolean(child?.running);
  const [open, setOpen] = useState(running);

  const rows = steps?.steps ?? [];
  const visible = rows.slice(-VISIBLE_STEPS);
  const earlier = (steps?.total ?? rows.length) - visible.length;

  return (
    <div className="subagent">
      <button
        type="button"
        className="subagent-spawn"
        onClick={() => {
          haptic('light');
          setOpen((prev) => !prev);
        }}
      >
        <Creature slot={spawn.hue} />
        <span className="step-label">Spawned {spawn.description}</span>
        <span className="step-chevron">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>

      {open ? (
        <div className="subagent-card">
          <div className="subagent-head">
            <Creature slot={spawn.hue} size={15} />
            <span className="subagent-title">
              {child?.title || spawn.description}
            </span>
            {child?.modelLabel ? (
              <span className="badge subagent-model">
                <ProviderMark id={child.provider || ''} size={11} />
                {child.modelLabel}
              </span>
            ) : null}
            <StatusBadge status={child?.status} running={running} />
            {child ? (
              <button
                type="button"
                className="subagent-open"
                aria-label={`Open ${child.title}`}
                onClick={() => onInspect(child.id, child.title)}
              >
                <ChevronRight size={15} />
              </button>
            ) : null}
          </div>

          <div className="subagent-body">
            {spawn.prompt ? (
              <p className="subagent-brief">{spawn.prompt}</p>
            ) : null}
            {earlier > 0 ? (
              <p className="subagent-earlier">+{earlier} earlier steps</p>
            ) : null}
            {visible.map((step) => (
              <SubagentStep key={step.id} step={step} />
            ))}
            {!rows.length && running ? (
              <p className="subagent-earlier">Starting…</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A subagent's status.
 *
 * The daemon's own vocabulary is passed through rather than mapped onto a
 * two-state Done/Failed: `interrupted` is a real outcome and reads wrong as
 * either of them.
 */
function StatusBadge({
  status,
  running,
}: {
  status: string | undefined;
  running: boolean;
}) {
  if (running) {
    return (
      <span className="badge subagent-status">
        <Spinner size={11} />
        Running
      </span>
    );
  }
  if (!status) return null;
  const failed = status === 'errored' || status === 'interrupted';
  const label = status === 'idle' ? 'Done' : status[0].toUpperCase() + status.slice(1);
  return (
    <span className={`badge subagent-status ${failed ? 'is-error' : ''}`}>
      {label}
    </span>
  );
}

/** One line of the subagent's own work, with a spinner while it is open. */
function SubagentStep({ step }: { step: WorkStep }) {
  return (
    <div className="subagent-step">
      {step.status === 'pending' ? (
        <Spinner size={13} />
      ) : (
        <StepGlyph icon={step.icon} size={13} />
      )}
      <span className={step.status === 'pending' ? 'is-pending' : ''}>
        {step.label}
      </span>
    </div>
  );
}
