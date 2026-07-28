/**
 * Which subagents a session has, kept fresh enough to render live.
 *
 * Thread building is synchronous and happens on every transcript write, but
 * the child list comes from an async SQLite read. Rather than make the whole
 * build path async for a lookup that changes a handful of times per turn,
 * this keeps a small snapshot per parent: readers take whatever is current
 * (never blocking), and the read schedules a refresh when the snapshot has
 * gone stale. A refresh that actually changed something emits `updated`, and
 * the WebSocket answers that with a push -- so a spawn appears within a
 * refresh interval of happening.
 *
 * The TTL is short while a child is running and long once they have all
 * finished, because a finished child's row never changes again.
 */
import { EventEmitter } from 'node:events';
import type { ChildSession } from './thread.js';
import type { StateChildRow } from './statedb.js';

const RUNNING_TTL_MS = 2_000;
const SETTLED_TTL_MS = 30_000;

export interface SubagentSnapshot {
  children: ChildSession[];
  /** Changes whenever the children do, so thread caches can key on it. */
  stamp: string;
}

export const EMPTY_SNAPSHOT: SubagentSnapshot = { children: [], stamp: '-' };

/** The daemon marks a child `running` while its turn is in flight. */
export function isRunning(status: string): boolean {
  return status === 'running';
}

export function toChildSession(
  row: StateChildRow,
  modelLabel: (provider: string, modelId: string) => string,
): ChildSession {
  return {
    id: row.id,
    title: row.title || 'Subagent',
    status: row.status,
    toolCallId: row.toolCallId,
    modelLabel: row.model ? modelLabel(row.model.provider, row.model.modelId) : null,
    running: isRunning(row.status),
  };
}

interface Entry {
  snapshot: SubagentSnapshot;
  at: number;
  refreshing: boolean;
}

export class SubagentIndex extends EventEmitter {
  private entries = new Map<string, Entry>();

  constructor(
    private readonly query: (parentId: string) => Promise<ChildSession[] | null>,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  /**
   * The current snapshot, and a refresh scheduled if it has aged out.
   * Never blocks: a parent that has not been read yet reports no children
   * and gets them on the next push.
   *
   * `active` is the parent's own busy state, and it matters: a session that
   * has never had a subagent looks settled, so without it the first spawn of
   * a turn would wait out the long TTL before appearing.
   */
  snapshot(parentId: string, active = false): SubagentSnapshot {
    const entry = this.entries.get(parentId);
    const ttl =
      active || entry?.snapshot.children.some((c) => c.running)
        ? RUNNING_TTL_MS
        : SETTLED_TTL_MS;
    if (!entry || this.now() - entry.at >= ttl) void this.refresh(parentId);
    return entry?.snapshot ?? EMPTY_SNAPSHOT;
  }

  /** Force a read now -- used when a turn ends, where a TTL wait would show. */
  async refresh(parentId: string): Promise<SubagentSnapshot> {
    const existing = this.entries.get(parentId);
    if (existing?.refreshing) return existing.snapshot;
    if (existing) existing.refreshing = true;

    const children = await this.query(parentId).catch(() => null);
    const stamp = children ? stampOf(children) : (existing?.snapshot.stamp ?? '-');
    const snapshot: SubagentSnapshot =
      children && stamp !== existing?.snapshot.stamp
        ? { children, stamp }
        : (existing?.snapshot ?? EMPTY_SNAPSHOT);

    this.entries.delete(parentId);
    this.entries.set(parentId, { snapshot, at: this.now(), refreshing: false });
    // Bounded for the same reason the thread and state caches are: the key
    // is a session id, and there are thousands of those on disk.
    while (this.entries.size > MAX_SUBAGENT_ENTRIES) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    if (snapshot !== existing?.snapshot) this.emit('updated', parentId);
    return snapshot;
  }
}

const MAX_SUBAGENT_ENTRIES = 256;

/** Identity of a child list: ids and the states that drive the UI. */
function stampOf(children: ChildSession[]): string {
  return children.map((c) => `${c.id}:${c.status}:${c.title}`).join('|') || '-';
}
