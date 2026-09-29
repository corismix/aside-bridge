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
import { Folder, Check } from './Icons';
import { AdaptivePickerSurface, PickerGroup, PickerRow } from './AdaptivePickerSurface';
import { ProjectGlyphForProject } from '../utils/projects';
import type { AsideProject } from '../types';

export interface ProjectSheetProps {
  anchor: HTMLElement | null;
  projects: AsideProject[];
  current: string;
  onPick: (projectId: string) => void;
  onClose: () => void;
}

/** Row glyph with the project's own icon, tinted by its colour. */
function Glyph({ pr, size = 17 }: { pr: AsideProject; size?: number }) {
  return (
    <span className="project-icon">
      <ProjectGlyphForProject project={pr} size={size} />
    </span>
  );
}

export function ProjectSheet({ anchor, projects, current, onPick, onClose }: ProjectSheetProps) {
  const nameCounts = new Map<string, number>();
  for (const project of projects) nameCounts.set(project.name, (nameCounts.get(project.name) || 0) + 1);
  return (
    <AdaptivePickerSurface anchor={anchor} title="Projects" onClose={onClose} width={280}>
      <PickerGroup>
        <PickerRow
          title="No project"
          leading={<Folder size={16} strokeWidth={1.75} />}
          selected={current === ''}
          trailing={current === '' ? <Check size={15} /> : null}
          onClick={() => onPick('')}
        />
        {projects.map((pr) => (
          <PickerRow
            key={pr.id}
            title={pr.name}
            subtitle={nameCounts.get(pr.name)! > 1 ? pr.workspacePath : undefined}
            leading={<Glyph pr={pr} />}
            selected={current === pr.id}
            trailing={current === pr.id ? <Check size={15} /> : null}
            onClick={() => onPick(pr.id)}
          />
        ))}
      </PickerGroup>
    </AdaptivePickerSurface>
  );
}
