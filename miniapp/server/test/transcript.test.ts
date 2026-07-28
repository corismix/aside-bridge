import { describe, expect, it } from 'vitest';
import {
  parseTranscript,
  stripMarkdown,
  TranscriptParser,
} from '../src/transcript.js';
import { readFixture } from './helpers.js';

describe('transcript parser', () => {
  it('parses text, thinking, tool calls and tool results', () => {
    const { entries } = parseTranscript(readFixture('2026-01-02_fixtureAAAA'));
    const kinds = entries.map((e) => e.kind);

    // the system-message line produces nothing
    expect(kinds).toEqual([
      'user',
      'thinking',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'assistant_text',
    ]);

    const user = entries[0] as any;
    expect(user.text).toBe('Summarize the fixture plan');
    expect(user.line).toBe(1);

    const thinking = entries[1] as any;
    expect(thinking.text).toContain('summary of the fixture plan');

    const titled = entries[2] as any;
    expect(titled.title).toBe('Read example.txt'); // arguments.title wins
    expect(titled.name).toBe('read_file');

    const untitled = entries[4] as any;
    expect(untitled.title).toBe('list_directory'); // falls back to tool name

    const errored = entries[5] as any;
    expect(errored.isError).toBe(true);
    expect(errored.preview).toBe('example.txt notes.md');

    const final = entries[6] as any;
    expect(final.text).toContain('fixture summary');
    expect(final.model).toBe('claude-sonnet-5');
  });

  it('gives every entry a stable id keyed on line and part', () => {
    const { entries } = parseTranscript(readFixture('2026-01-02_fixtureAAAA'));
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[1]).toBe('2:0');
    expect(ids[2]).toBe('2:1');
  });

  it('tracks the subagent lifecycle across the task_id re-key', () => {
    const { entries } = parseTranscript(readFixture('2026-01-03_fixtureBBBB'));
    const subagents = entries.filter((e) => e.kind === 'subagent') as any[];

    expect(subagents.map((s) => s.event)).toEqual(['spawn', 'wait', 'result']);

    expect(subagents[0].desc).toBe('Audit the config loader'); // whitespace collapsed
    expect(subagents[0].profile).toBe('explore');
    expect(subagents[0].background).toBe(true);

    // wait + result carry only a task_id, yet resolve to the spawn's
    // description because the spawn toolResult re-keyed the registry.
    expect(subagents[1].taskId).toBe('task_fixture_9001');
    expect(subagents[1].desc).toBe('Audit the config loader');
    expect(subagents[2].desc).toBe('Audit the config loader');
    expect(subagents[2].text).toBe(
      'The config loader handles missing files cleanly.',
    );
    expect(subagents[2].isError).toBe(false);
  });

  it('drops the partial trailing line and reports the last complete line', () => {
    const buffer = readFixture('2026-01-03_fixtureBBBB');
    expect(buffer.endsWith('\n')).toBe(false); // fixture ends mid-write
    const { entries, lastLine } = parseTranscript(buffer);

    expect(lastLine).toBe(6); // the 8th line is incomplete
    const texts = entries.filter((e) => e.kind === 'assistant_text') as any[];
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toBe('The audit came back clean.');
  });

  it('emits the partial line once it is completed', () => {
    const partial = readFixture('2026-01-03_fixtureBBBB');
    const completed = `${partial}ten"}],"timestamp":1767398407}\n`;
    const { entries, lastLine } = parseTranscript(completed);
    const texts = entries.filter((e) => e.kind === 'assistant_text') as any[];
    expect(lastLine).toBe(7);
    expect(texts.map((t) => t.text)).toEqual([
      'The audit came back clean.',
      'this line is still being written',
    ]);
  });

  it('honours afterLine while still replaying subagent state', () => {
    const buffer = readFixture('2026-01-03_fixtureBBBB');
    const { entries } = parseTranscript(buffer, { afterLine: 3 });
    expect(entries.every((e) => e.line > 3)).toBe(true);
    const result = entries.find(
      (e) => e.kind === 'subagent' && (e as any).event === 'result',
    ) as any;
    // desc only resolves if lines 1-2 were replayed despite being filtered
    expect(result.desc).toBe('Audit the config loader');
  });

  it('skips corrupt lines instead of throwing', () => {
    const parser = new TranscriptParser();
    expect(parser.feedLine('{not json', 0)).toEqual([]);
    expect(parser.feedLine('', 1)).toEqual([]);
    expect(parser.feedLine('{"role":"user","content":"ok"}', 2)).toHaveLength(1);
  });

  it('emits one entry per task_id in a multi-subagent wait result', () => {
    const parser = new TranscriptParser();
    parser.feedLine(
      JSON.stringify({
        role: 'toolResult',
        toolCallId: 'toolu_wait',
        toolName: 'subagent_wait',
        content: [
          {
            type: 'text',
            text:
              '<subagent_result task_id="t1">first</subagent_result>' +
              '<subagent_result task_id="t2">second</subagent_result>',
          },
        ],
        isError: false,
        timestamp: 1767398404,
      }),
      0,
    );
    const entries = parser.feedLine(
      JSON.stringify({
        role: 'toolResult',
        toolCallId: 'toolu_wait2',
        toolName: 'subagent_wait',
        content: [
          {
            type: 'text',
            text:
              '<subagent_result task_id="t3">third</subagent_result>' +
              '<subagent_result task_id="t4">fourth</subagent_result>',
          },
        ],
        isError: true,
        timestamp: 1767398405,
      }),
      1,
    ) as any[];
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.taskId)).toEqual(['t3', 't4']);
    expect(entries.map((e) => e.text)).toEqual(['third', 'fourth']);
    expect(entries.every((e) => e.isError)).toBe(true);
    expect(new Set(entries.map((e) => e.id)).size).toBe(2);
  });
});

describe('stripMarkdown', () => {
  it('flattens the syntax that would otherwise show in a card preview', () => {
    expect(stripMarkdown('1. **Opener** — today’s a double SAT day')).toBe(
      'Opener — today’s a double SAT day',
    );
    expect(stripMarkdown('Full plan saved to **`artifacts/plan.md`**')).toBe(
      'Full plan saved to artifacts/plan.md',
    );
    expect(stripMarkdown('## Heading\n- bullet\n> quote')).toBe(
      'Heading\nbullet\nquote',
    );
    expect(stripMarkdown('see [the docs](https://x.com)')).toBe('see the docs');
    expect(stripMarkdown('_emphasis_ and *stars*')).toBe('emphasis and stars');
  });

  it('leaves ordinary prose and intra-word underscores alone', () => {
    expect(stripMarkdown('plain sentence, no markup')).toBe(
      'plain sentence, no markup',
    );
    expect(stripMarkdown('call read_file with a_b_c')).toBe(
      'call read_file with a_b_c',
    );
  });

  it('drops fenced code rather than dumping it into the preview', () => {
    expect(stripMarkdown('before\n```js\nconst x = 1;\n```\nafter').trim())
      .toBe('before\n \nafter'.trim());
  });

  it('handles empty input', () => {
    expect(stripMarkdown('')).toBe('');
  });
});
