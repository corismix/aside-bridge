/**
 * The session list, in Aside's two views.
 *
 * A `List | Card` segmented control switches between them and the choice
 * persists, exactly as in the sidepanel. Mobile defaults to List: cards
 * are handsome but show two per screen on a phone.
 *
 * What is deliberately NOT rendered here: session ids, costs, token
 * counts, turn counts. The sidepanel shows none of those, so neither does
 * this. Only the title, when it last moved, whether it is unread, and
 * whether it is running.
 */
import { useMemo, useState } from 'react';
import type { SessionRow } from '../types';
import { relativeTime } from '../utils/time';
import { ArrowDownUp, LayoutGrid, ListIcon, Search, Spinner } from './Icons';
import { haptic } from '../telegram';

const VIEW_KEY = 'miniapp.sessionView';

export type SessionView = 'list' | 'card';

export function readStoredView(): SessionView {
  const stored = localStorage.getItem(VIEW_KEY);
  return stored === 'card' ? 'card' : 'list';
}

export interface SessionListProps {
  sessions: SessionRow[];
  onOpen: (id: string) => void;
  loading?: boolean;
}

export function SessionList({ sessions, onOpen, loading }: SessionListProps) {
  const [view, setView] = useState<SessionView>(readStoredView);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [oldestFirst, setOldestFirst] = useState(false);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            s.preview.toLowerCase().includes(q),
        )
      : sessions;
    return oldestFirst ? [...filtered].reverse() : filtered;
  }, [sessions, query, oldestFirst]);

  const choose = (next: SessionView) => {
    setView(next);
    localStorage.setItem(VIEW_KEY, next);
    haptic('light');
  };

  const open = (id: string) => {
    haptic('light');
    onOpen(id);
  };

  return (
    <div className="session-area">
      <div className="list-toolbar">
        <div className="segmented" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'list'}
            className={view === 'list' ? 'is-active' : ''}
            onClick={() => choose('list')}
          >
            <ListIcon size={15} strokeWidth={1.75} />
            List
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'card'}
            className={view === 'card' ? 'is-active' : ''}
            onClick={() => choose('card')}
          >
            <LayoutGrid size={15} strokeWidth={1.75} />
            Card
          </button>
        </div>

        <span className="composer-spacer" />

        <button
          type="button"
          className="icon-button"
          aria-label="Search sessions"
          onClick={() => {
            setSearching((prev) => !prev);
            if (searching) setQuery('');
          }}
        >
          <Search size={17} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Reverse order"
          onClick={() => setOldestFirst((prev) => !prev)}
        >
          <ArrowDownUp size={17} strokeWidth={1.75} />
        </button>
      </div>

      {searching ? (
        <input
          className="list-search"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search chats"
        />
      ) : null}

      {loading && sessions.length === 0 ? (
        <p className="list-empty">Loading chats…</p>
      ) : null}
      {!loading && visible.length === 0 ? (
        <p className="list-empty">
          {query ? 'No chats match that.' : 'No chats yet.'}
        </p>
      ) : null}

      {view === 'list' ? (
        <div className="session-rows">
          {visible.map((session) => (
            <button
              key={session.id}
              type="button"
              className="session-row"
              onClick={() => open(session.id)}
            >
              <span className="session-row-main">
                <span className="session-row-title">{session.title}</span>
                <span className="session-row-time">
                  {relativeTime(session.updatedAt)}
                </span>
              </span>
              <span className="session-row-marks">
                {session.status === 'running' ? <Spinner size={13} /> : null}
                {session.unread ? <span className="unread-dot" /> : null}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="session-cards">
          {visible.map((session) => (
            <button
              key={session.id}
              type="button"
              className="session-card"
              onClick={() => open(session.id)}
            >
              <span className="session-card-head">
                <span className="session-card-time">
                  {relativeTime(session.updatedAt)}
                </span>
                {session.status === 'running' ? <Spinner size={13} /> : null}
                {session.unread ? <span className="unread-dot" /> : null}
              </span>
              <span className="session-card-title">{session.title}</span>
              {session.preview ? (
                <span className="session-card-preview">{session.preview}</span>
              ) : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
