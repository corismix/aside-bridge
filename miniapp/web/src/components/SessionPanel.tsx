import { useEffect, useState } from 'react';
import { Sheet } from './Sheet';
import { Creature } from './Creature';
import { FileIcon, Spinner } from './Icons';
import { FileViewer } from './FileViewer';
import { api } from '../api';
import { formatBytes } from '../utils/format';
import { relativeTime } from '../utils/time';
import type { ArtifactFile, ArtifactGroup, ChildSession } from '../types';

const GROUP_LABELS: Record<ArtifactGroup, string> = {
  artifacts: 'Files',
  attachments: 'Attachments',
};

/**
 * The session sidebar: who worked on this, and what came out of it.
 *
 * Mirrors what the desktop app keeps beside a session -- its subagents and
 * its artifacts -- as a right-edge sheet, since a phone has no room for a
 * permanent column. Subagents come from the thread payload, which already
 * has them; files are fetched when the panel opens, because nothing else in
 * the app needs them.
 */
export function SessionPanel({
  sessionId,
  subagents,
  onInspectSubagent,
  onClose,
}: {
  sessionId: string;
  subagents: ChildSession[];
  onInspectSubagent: (childId: string, title: string) => void;
  onClose: () => void;
}) {
  const [groups, setGroups] = useState<
    Array<{ id: ArtifactGroup; files: ArtifactFile[] }> | null
  >(null);
  const [open, setOpen] = useState<{ group: ArtifactGroup; file: ArtifactFile } | null>(
    null,
  );

  useEffect(() => {
    let alive = true;
    api.artifacts(sessionId).then(
      (res) => alive && setGroups(res.groups),
      () => alive && setGroups([]),
    );
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const populated = (groups ?? []).filter((group) => group.files.length);

  return (
    <>
      <Sheet side="right" title="Session" onClose={onClose}>
        <section className="panel-section">
          <h3 className="panel-heading">Subagents</h3>
          {subagents.length ? (
            <ul className="panel-list">
              {subagents.map((child) => (
                <li key={child.id}>
                  <button
                    type="button"
                    className="panel-row"
                    onClick={() => onInspectSubagent(child.id, child.title)}
                  >
                    <Creature slot={child.hue} />
                    <span className="panel-row-name">{child.title}</span>
                    <span
                      className={`badge ${child.running ? '' : 'is-muted'}`}
                    >
                      {child.running ? 'Running' : 'Done'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="panel-empty">No subagents in this session.</p>
          )}
        </section>

        <section className="panel-section">
          {groups === null ? (
            <p className="panel-empty">
              <Spinner size={13} /> Loading files…
            </p>
          ) : populated.length ? (
            populated.map((group) => (
              <div key={group.id}>
                <h3 className="panel-heading">{GROUP_LABELS[group.id]}</h3>
                <ul className="panel-list">
                  {group.files.map((file) => (
                    <li key={file.path}>
                      <button
                        type="button"
                        className="panel-row"
                        onClick={() => setOpen({ group: group.id, file })}
                      >
                        <FileIcon size={14} strokeWidth={1.75} />
                        <span className="panel-row-name">{file.name}</span>
                        <span className="panel-row-meta">
                          {formatBytes(file.size)} · {relativeTime(file.mtime)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          ) : (
            <>
              <h3 className="panel-heading">Files</h3>
              <p className="panel-empty">This session has no files yet.</p>
            </>
          )}
        </section>
      </Sheet>

      {open ? (
        <FileViewer
          sessionId={sessionId}
          group={open.group}
          file={open.file}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}
