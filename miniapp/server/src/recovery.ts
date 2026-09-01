/** Bounded, visible continuity for a replacement ephemeral session. */
import { readHistory } from './jsonl.js';
import { stripAgentDirectives } from './preamble.js';

const MAX_BLOCKS = 12;
const MAX_CHARS = 12_000;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is Record<string, unknown> => !!part && typeof part === 'object')
    .filter((part) => part.type === 'text')
    .map((part) => String(part.text || ''))
    .join('\n');
}

export function boundedContinuity(msgFile: string | null): string {
  if (!msgFile) return '';
  let rows: Array<[string, string]> = [];
  try {
    rows = readHistory(msgFile)
      .filter((row) => row.role === 'user' || row.role === 'assistant')
      .map((row) => [row.role, stripAgentDirectives(textOf(row.content)).trim()] as [string, string])
      .filter(([, text]) => !!text && !/permanent telegram thread/i.test(text));
  } catch {
    return '';
  }
  rows = rows.slice(-MAX_BLOCKS);
  while (rows.length && rows.reduce((n, [, text]) => n + text.length, 0) > MAX_CHARS) rows.shift();
  return rows.map(([role, text]) => `${role}: ${text}`).join('\n\n');
}

export function replacementPrompt(msgFile: string | null, current: string): string {
  const continuity = boundedContinuity(msgFile);
  return continuity
    ? `Recent visible conversation for continuity only:\n${continuity}\n\nCurrent user input:\n${current}`
    : current;
}
