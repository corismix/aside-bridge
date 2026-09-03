/**
 * Project picker for new sessions.
 *
 * Mirrors ModelSheet's grouped-row shape so the composer's sheets read as
 * one family. Rows carry the project's own icon and colour from the
 * desktop app (via aside.projects.list()), rendered as bare icons tinted
 * with the project's colour -- exactly how Aside's own project menu draws
 * them (coloured glyph, no chip).
 * Picking a project only affects the NEXT session: the CLI cannot anchor
 * a session row to a project (see server/src/projects.ts), so a mobile
 * project session is a normal session seeded with the project's workspace
 * path and its AGENTS.md / MEMORY.md.
 */
import { Sheet } from './Sheet';
import { Folder } from './Icons';
import { projectIcon, projectTint } from '../utils/projects';
import type { AsideProject } from '../types';

export interface ProjectSheetProps {
  projects: AsideProject[];
  current: string;
  onPick: (projectId: string) => void;
  onClose: () => void;
}

/** Row glyph with the project's own icon, tinted by its colour. */
function Glyph({ pr, size = 17 }: { pr: AsideProject; size?: number }) {
  const Icon = projectIcon(pr.icon);
  const tint = projectTint(pr.color);
  return (
    <span className="project-icon" style={{ color: tint.fg }}>
      <Icon size={size} strokeWidth={1.75} />
    </span>
  );
}

export function ProjectSheet({ projects, current, onPick, onClose }: ProjectSheetProps) {
  return (
    <Sheet side="bottom" title="Project" onClose={onClose}>
      <div className="sheet-group">
        <button
          type="button"
          className={`sheet-row ${current === '' ? 'is-selected' : ''}`}
          onClick={() => onPick('')}
        >
          <span className="project-icon project-icon-muted">
            <Folder size={17} strokeWidth={1.75} />
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
            <Glyph pr={pr} />
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

