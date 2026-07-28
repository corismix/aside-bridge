/**
 * The agent's task list, replayed out of its `write_todos` calls.
 *
 * There is no "current todos" field anywhere in the session state -- the
 * list only exists as the sequence of calls that built it, so the current
 * state is whatever replaying them in order produces. Two modes, and the
 * flag that selects between them is `merge`:
 *
 *  - `merge: false` REPLACES the whole list. This is the first call of a
 *    turn, and the one that drops items the agent has abandoned.
 *  - `merge: true` merges BY ID into the prior state: an id already present
 *    is updated in place (keeping its position), an id that is new is
 *    appended. Items the merge does not mention are left alone -- which is
 *    the point of merging, and the thing a naive "last call wins" read gets
 *    wrong, because a merge call routinely names only the items whose
 *    status changed.
 *
 * Both shapes are in real transcripts; see the tests, which are built from
 * calls copied out of one.
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface Todo {
  id: string;
  content: string;
  status: TodoStatus;
}

const STATUSES: TodoStatus[] = [
  'pending',
  'in_progress',
  'completed',
  'cancelled',
];

function asStatus(raw: unknown): TodoStatus {
  const value = String(raw ?? '').trim();
  return (STATUSES as string[]).includes(value)
    ? (value as TodoStatus)
    : 'pending';
}

/** One `write_todos` call's `todos` array, cleaned. */
export function readTodos(raw: unknown): Todo[] {
  if (!Array.isArray(raw)) return [];
  const out: Todo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const content = String(entry.content ?? '').trim();
    if (!content) continue;
    // An id is what merge keys on. A call that omits one still has to
    // produce a stable key, so the content is used -- two todos with the
    // same text are the same todo as far as a reader is concerned.
    const id = String(entry.id ?? '').trim() || content;
    out.push({ id, content, status: asStatus(entry.status) });
  }
  return out;
}

/**
 * Apply one call to the prior state.
 *
 * Exported separately from `replayTodos` because the merge rule is the part
 * worth asserting directly, independently of transcript shape.
 */
export function applyTodoCall(
  prior: Todo[],
  next: Todo[],
  merge: boolean,
): Todo[] {
  if (!merge) return next;

  const byId = new Map(prior.map((todo) => [todo.id, todo]));
  const order = prior.map((todo) => todo.id);
  for (const todo of next) {
    if (!byId.has(todo.id)) order.push(todo.id);
    byId.set(todo.id, todo);
  }
  return order.map((id) => byId.get(id)!).filter(Boolean);
}

/** A `write_todos` toolCall's arguments, as the transcript records them. */
export interface TodoCallArgs {
  merge?: unknown;
  todos?: unknown;
}

/**
 * Replay every `write_todos` call, oldest first, into the current list.
 *
 * `merge` defaults to false when absent, matching the tool's own default:
 * a call that says nothing about merging is a full write.
 */
export function replayTodos(calls: TodoCallArgs[]): Todo[] {
  let state: Todo[] = [];
  for (const call of calls) {
    if (!call || typeof call !== 'object') continue;
    state = applyTodoCall(state, readTodos(call.todos), call.merge === true);
  }
  return state;
}

/**
 * The one-line summary the collapsed section shows.
 *
 * The in-progress item is what the reader wants when there is one; failing
 * that the next pending item, because "what happens next" is the second
 * most useful thing. A finished list says so rather than showing the last
 * completed item, which reads as if work is still going on.
 */
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
