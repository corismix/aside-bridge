/**
 * Aside project listing for the mini app.
 *
 * `aside.projects` exposes only `list()` over the repl CLI. There is no
 * way to create a project-anchored session from the CLI at all: `aside
 * exec` has no project flag, a session's process cwd does not carry into
 * the session row, and `aside.sessions.update` silently ignores
 * `projectId` and `cwd` (all verified 2026-09-03 against a throwaway
 * session). So project support here is prompt-level, exactly like the
 * bridge's `/project` command: a chosen project is validated against the
 * real list, and fresh sessions are seeded with the project's workspace
 * path plus its AGENTS.md / MEMORY.md.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultAsideRoot } from './config.js';

const execFileP = promisify(execFile);

export interface AsideProject {
  id: string;
  name: string;
  icon?: string;
  color?: string;
  workspacePath: string;
  lastActiveAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Cache lives long enough that /api/projects is instant, short enough
 * that a project created on the desktop shows up within a minute. */
const CACHE_TTL_MS = 60_000;
let cache: { at: number; projects: AsideProject[] } | null = null;

/**
 * The repl prints the logged JSON on its own stdout line, followed by a
 * status line like `[ok | 6ms]` with ANSI colour codes. Scan the lines in
 * reverse and take the first one that parses, so cosmetic status output
 * can never break the parse.
 */
function parseProjectsLine(stdout: string): AsideProject[] | null {
  const clean = stdout.replace(/\x1b\[[0-9;]*m/g, '');
  const lines = clean.split('\n').map((l) => l.trim()).reverse();
  for (const line of lines) {
    if (!line.startsWith('[') && !line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      if (Array.isArray(parsed)) return parsed as AsideProject[];
    } catch {
      // keep scanning
    }
  }
  return null;
}

export async function listAsideProjects(
  asideCli: string,
  timeoutMs = 30_000,
): Promise<AsideProject[]> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.projects;
  try {
    const { stdout } = await execFileP(
      asideCli,
      ['repl', 'console.log(JSON.stringify(await aside.projects.list()))'],
      { timeout: timeoutMs },
    );
    const projects = parseProjectsLine(stdout);
    if (projects) {
      cache = { at: now, projects };
      return projects;
    }
  } catch (err) {
    console.error('[projects] list failed:', (err as Error).message);
  }
  return cache ? cache.projects : [];
}

export async function findProject(
  asideCli: string,
  projectId: string,
): Promise<AsideProject | null> {
  const projects = await listAsideProjects(asideCli);
  return projects.find((p) => p.id === projectId) ?? null;
}

/**
 * The seed text that points a fresh session at its project. The project's
 * own AGENTS.md / MEMORY.md live either in the workspace itself (code
 * projects) or under the aside project directory (aside-hosted ones);
 * read whichever copy actually exists, at most 8k per file.
 */
export async function projectContextBlock(pr: AsideProject): Promise<string> {
  const parts = [
    `PROJECT CONTEXT (from the bridge): you are now working on the Aside ` +
      `project '${pr.name}' (id ${pr.id}). Its workspace root is ` +
      `${pr.workspacePath} -- treat that path as the project root for all ` +
      `file work.`,
  ];
  const seen = new Set<string>();
  for (const fname of ['AGENTS.md', 'MEMORY.md']) {
    for (const cand of [
      pr.workspacePath.startsWith('~')
        ? pr.workspacePath.replace('~', os.homedir())
        : pr.workspacePath,
      path.join(defaultAsideRoot(), 'projects', pr.id),
    ].map((dir) => `${dir}/${fname}`)) {
      if (seen.has(cand)) continue;
      seen.add(cand);
      try {
        const body = (await fs.promises.readFile(cand, 'utf8')).trim();
        if (body) parts.push(`--- ${fname} (${cand}) ---\n${body.slice(0, 8000)}`);
        break;
      } catch {
        // try the next candidate location
      }
    }
  }
  return parts.join('\n\n');
}
