/**
 * Project picker for new sessions.
 *
 * Mirrors ModelSheet's grouped-row shape so the composer's sheets read as
 * one family. Picking a project only affects the NEXT session: the CLI
 * cannot anchor a session row to a project (see server/src/projects.ts),
 * so a mobile project session is a normal session seeded with the
 * project's workspace path and its AGENTS.md / MEMORY.md.
 */
import { Sheet } from './Sheet';
import { BookOpen } from './Icons';
import type { AsideProject } from '../types';

export interface ProjectSheetProps {
  projects: AsideProject[];
  current: string;
  onPick: (projectId: string) => void;
  onClose: () => void;
}

export function ProjectSheet({
  projects,
  current,
  onPick,
  onClose,
}: ProjectSheetProps) {
  return (
    <Sheet side="bottom" title="Project" onClose={onClose}>
      <div className="sheet-group">
        <button
          type="button"
          className={`sheet-row ${current === '' ? 'is-selected' : ''}`}
          onClick={() => onPick('')}
        >
          <span className="sheet-row-glyph">
            <BookOpen size={17} strokeWidth={1.75} />
          </span>
          <span className="sheet-row-text">
            <span className="sheet-row-title">No project</span>
            <span className="sheet-row-subtitle">
              Plain session at the Aside root
            </span>
          </span>
        </button>
        {projects.map((pr) => (
          <button
            key={pr.id}
            type="button"
            className={`sheet-row ${current === pr.id ? 'is-selected' : ''}`}
            onClick={() => onPick(pr.id)}
          >
            <span className="sheet-row-glyph">
              <BookOpen size={17} strokeWidth={1.75} />
            </span>
            <span className="sheet-row-text">
              <span className="sheet-row-title">{pr.name}</span>
              <span className="sheet-row-subtitle">{pr.workspacePath}</span>
            </span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}
