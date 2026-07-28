/**
 * A session's files: what the agent wrote, and what was sent to it.
 *
 * Two directories live under a session: `artifacts/`, which is where the
 * agent's own write_file output lands (usually inside a dated subfolder),
 * and `attachments/`, which holds what came in with a message. Both are
 * listed recursively and served read-only.
 *
 * The path check is the important part of this module. A caller names a
 * file by a relative path, so every resolution is realpath'd and then
 * verified to still sit under the realpath'd group directory -- which
 * rejects `../` traversal and, just as importantly, a symlink inside the
 * artifacts tree pointing at the rest of the machine.
 */
import fs from 'node:fs';
import path from 'node:path';

export type ArtifactGroup = 'artifacts' | 'attachments';
const ARTIFACT_GROUPS: ArtifactGroup[] = ['artifacts', 'attachments'];

export type ArtifactKind = 'markdown' | 'image' | 'code' | 'text' | 'binary';

export interface ArtifactFile {
  /** Path relative to the group directory, and the id the client sends back. */
  path: string;
  name: string;
  size: number;
  mtime: number;
  kind: ArtifactKind;
}

/** Files served inline top out here; bigger ones are a download. */
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

/** Deep enough for `artifacts/<date>/<subfolder>/file`, shallow enough to bound. */
const MAX_DEPTH = 6;
const MAX_FILES = 500;

const KINDS: Record<string, ArtifactKind> = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.svg': 'image',
  '.ts': 'code',
  '.tsx': 'code',
  '.js': 'code',
  '.jsx': 'code',
  '.py': 'code',
  '.sh': 'code',
  '.json': 'code',
  '.yaml': 'code',
  '.yml': 'code',
  '.html': 'code',
  '.css': 'code',
  '.sql': 'code',
  '.txt': 'text',
  '.csv': 'text',
  '.log': 'text',
};

const CONTENT_TYPES: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

export function artifactKind(name: string): ArtifactKind {
  return KINDS[path.extname(name).toLowerCase()] || 'binary';
}

/**
 * Content type for a download.
 *
 * Anything not in the table is served as an opaque download rather than
 * guessed at: a transcript-adjacent file the browser decides to render as
 * HTML would be running attacker-influenced markup on our origin.
 */
export function artifactContentType(name: string): string {
  return CONTENT_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

export function isArtifactGroup(value: unknown): value is ArtifactGroup {
  return ARTIFACT_GROUPS.includes(value as ArtifactGroup);
}

/** Every file under a group directory, newest first. Missing reads as empty. */
export function listArtifacts(
  sessionDir: string,
  group: ArtifactGroup,
): ArtifactFile[] {
  const base = path.join(sessionDir, group);
  const out: ArtifactFile[] = [];

  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      const full = path.join(dir, entry.name);
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      // Symlinks are skipped outright rather than followed and then
      // rejected at read time -- a listing should not name what it will
      // refuse to serve.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(full, next, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(full, { throwIfNoEntry: false });
      if (!stat) continue;
      out.push({
        path: next,
        name: entry.name,
        size: stat.size,
        mtime: Math.round(stat.mtimeMs),
        kind: artifactKind(entry.name),
      });
    }
  };

  walk(base, '', 0);
  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Absolute path for a client-supplied relative path, or null if it escapes.
 *
 * Both sides are realpath'd before the containment check, so neither `../`
 * nor a symlink can name a file outside the group directory.
 */
export function resolveArtifact(
  sessionDir: string,
  group: ArtifactGroup,
  rel: string,
): string | null {
  if (!rel || rel.includes('\0')) return null;
  const base = path.join(sessionDir, group);
  let realBase: string;
  let realTarget: string;
  try {
    realBase = fs.realpathSync(base);
    realTarget = fs.realpathSync(path.resolve(base, rel));
  } catch {
    return null;
  }
  if (realTarget !== realBase && !realTarget.startsWith(realBase + path.sep)) {
    return null;
  }
  return fs.statSync(realTarget, { throwIfNoEntry: false })?.isFile()
    ? realTarget
    : null;
}
