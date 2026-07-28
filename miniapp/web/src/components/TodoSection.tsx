/**
 * The agent's task list.
 *
 * Two placements, both mirroring the desktop app:
 *
 *  - `TodoSection`, a compact strip sitting directly ON TOP of the
 *    composer. Collapsed by default: one row naming the current item with
 *    a count and a chevron. Expanded, the full checklist.
 *  - `TodoProgress`, the "Task progress" block at the bottom of the
 *    right-hand session panel.
 *
 * The open state here is purely manual and has no interaction with the work
 * fold's auto-expand rule. That is deliberate -- the fold follows the turn
 * (see `WorkFold.tsx`) and a second thing that opens and closes itself
 * around the composer would fight the reader for the same screen space.
 */
import { useState } from 'react';
import { ChevronDown, ChevronUp, TodoCircle } from './Icons';
import { haptic } from '../telegram';
import type { Todo } from '../types';

/** The row shown when the section is collapsed. */
export function todoSummary(todos: Todo[]): {
  label: string;
  done: number;
  total: number;
} | null {
  const live = todos.filter((todo) => todo.status !== 'cancelled');
  if (!live.length) return null;
  const done = live.filter((todo) => todo.status === 'completed').length;
  const current =
    live.find((todo) => todo.status === 'in_progress') ||
    live.find((todo) => todo.status === 'pending');
  return {
    label: current ? current.content : 'All tasks complete',
    done,
    total: live.length,
  };
}

function TodoRow({ todo }: { todo: Todo }) {
  return (
    <li className={`todo-row is-${todo.status}`}>
      <TodoCircle status={todo.status} />
      <span className="todo-content">{todo.content}</span>
    </li>
  );
}

export function TodoList({ todos }: { todos: Todo[] }) {
  return (
    <ul className="todo-list">
      {todos.map((todo) => (
        <TodoRow key={todo.id} todo={todo} />
      ))}
    </ul>
  );
}

export function TodoSection({ todos }: { todos: Todo[] }) {
  const [open, setOpen] = useState(false);
  const summary = todoSummary(todos);
  // An empty list is no section at all, rather than an empty box: a
  // session that never used the tool should look no different.
  if (!summary) return null;

  return (
    <div className={`todo-section ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="todo-toggle"
        aria-expanded={open}
        onClick={() => {
          haptic('light');
          setOpen((prev) => !prev);
        }}
      >
        {open ? (
          <span className="todo-toggle-title">Tasks</span>
        ) : (
          <>
            <TodoCircle
              status={
                summary.done === summary.total ? 'completed' : 'in_progress'
              }
              size={14}
            />
            <span className="todo-toggle-label">{summary.label}</span>
          </>
        )}
        <span className="todo-count">
          {summary.done}/{summary.total}
        </span>
        <span className="todo-chevron">
          {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </span>
      </button>
      {open ? <TodoList todos={todos} /> : null}
    </div>
  );
}

/** The session panel's "Task progress" block. */
export function TodoProgress({ todos }: { todos: Todo[] }) {
  if (!todos.length) return null;
  return (
    <section className="panel-section">
      <h3 className="panel-heading">Task progress</h3>
      <TodoList todos={todos} />
    </section>
  );
}
