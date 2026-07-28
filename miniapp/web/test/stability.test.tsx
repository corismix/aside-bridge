/**
 * Web-side regression tests for the stability batch.
 *
 * The fold's live/collapsed rule is a state machine and is tested as one --
 * that is where the "auto-expand is flaky" bug lived. The rest are about
 * what actually ends up in the DOM: an error card instead of nothing, a
 * question card instead of a JSON blob, a stop button only while a turn
 * runs, and a task list that starts collapsed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ErrorCard } from '../src/components/ErrorCard';
import { QuestionCard } from '../src/components/QuestionCard';
import { TodoSection, todoSummary } from '../src/components/TodoSection';
import { StreamFooter } from '../src/components/StreamFooter';
import { Composer } from '../src/components/Composer';
import { foldIsLive } from '../src/components/Thread';
import { ProviderMark, hasProviderMark } from '../src/components/Brand';
import type {
  ComposerAttachment,
  QuestionItem,
  ThreadItem,
  Todo,
} from '../src/types';

afterEach(cleanup);

// --- deliverable 4: the fold's live/collapsed state machine ---------------

function step(status: 'pending' | 'success') {
  return {
    kind: 'step' as const,
    id: `s-${status}`,
    icon: 'terminal' as const,
    label: 'Run something',
    tool: 'bash',
    status,
    diffstat: null,
    detail: null,
    images: [],
  };
}

function fold(running: boolean, steps = [step('success')]): ThreadItem {
  return {
    kind: 'work',
    id: 'work-1',
    items: steps,
    durationMs: 1000,
    running,
  };
}

const streaming: ThreadItem = { kind: 'streaming', id: 'streaming', text: 'so' };
const answer: ThreadItem = { kind: 'answer', id: 'answer-1', text: 'done', ts: 1 };

describe('when a work fold shows its timeline', () => {
  it('is live while the turn runs and nothing has followed it', () => {
    expect(foldIsLive([fold(true)], 0)).toBe(true);
  });

  it('is not live once the turn has finished', () => {
    expect(foldIsLive([fold(false)], 0)).toBe(false);
    expect(foldIsLive([fold(false), streaming], 0)).toBe(false);
  });

  it('collapses when the transcript has promoted an answer', () => {
    expect(foldIsLive([fold(true), answer], 0)).toBe(false);
  });

  it('collapses when the final answer starts streaming', () => {
    // Every step has settled, so streaming text is the answer.
    expect(foldIsLive([fold(true, [step('success')]), streaming], 0)).toBe(false);
  });

  it('STAYS live while mid-turn commentary streams over a running step', () => {
    // This is the bug. The old rule collapsed on any streaming text, so
    // every paragraph the agent narrated between tool calls slammed the
    // timeline shut and the next tool call flapped it back open.
    expect(
      foldIsLive([fold(true, [step('success'), step('pending')]), streaming], 0),
    ).toBe(true);
  });

  it('collapses when a question ends the turn', () => {
    const question: ThreadItem = {
      kind: 'question',
      id: 'q-1',
      variant: 'ask',
      source: 'tool',
      questions: [{ header: 'H', question: 'Q?', options: [] }],
      status: 'pending',
      answerable: false,
    };
    expect(foldIsLive([fold(true), question], 0)).toBe(false);
  });

  it('is never live for anything that is not a fold', () => {
    expect(foldIsLive([answer], 0)).toBe(false);
    expect(foldIsLive([streaming], 0)).toBe(false);
  });
});

// --- deliverable 3: the error card ---------------------------------------

describe('the error card', () => {
  const alert = {
    title: 'Request rate limited',
    description:
      'The model provider temporarily rate-limited this request. Try again later.',
    detail: 'Codex error: The usage limit has been reached',
    tone: 'muted' as const,
  };

  it('renders the title and description Aside uses', () => {
    render(<ErrorCard alert={alert} />);
    expect(screen.getByText('Request rate limited')).toBeTruthy();
    expect(screen.getByText(/temporarily rate-limited/)).toBeTruthy();
  });

  it('hides the raw provider message behind Details', () => {
    render(<ErrorCard alert={alert} />);
    expect(screen.queryByText(/usage limit has been reached/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText(/usage limit has been reached/)).toBeTruthy();
  });

  it('offers no Details button when it would just repeat the description', () => {
    render(
      <ErrorCard
        alert={{ ...alert, detail: alert.description }}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
  });
});

// --- deliverable 2: the question card ------------------------------------

const askItem: QuestionItem = {
  kind: 'question',
  id: 'q-1',
  variant: 'ask',
  source: 'marker',
  questions: [
    {
      header: 'Send test email?',
      question: 'Approve sending it?',
      options: [
        { label: 'Approve', description: 'Send the test email now' },
        { label: 'Deny', description: 'Just confirm the draft looked right' },
      ],
    },
  ],
  status: 'pending',
  answerable: true,
};

describe('the question card', () => {
  it('draws the question and its options, never raw JSON', () => {
    render(<QuestionCard item={askItem} onAnswer={vi.fn()} />);
    expect(screen.getByText('Send test email?')).toBeTruthy();
    expect(screen.getByText('Approve sending it?')).toBeTruthy();
    expect(screen.getByText('Send the test email now')).toBeTruthy();
    // The failure mode this replaces.
    expect(screen.queryByText(/"questions"/)).toBeNull();
    expect(screen.queryByText('Success')).toBeNull();
  });

  it('sends the chosen option with its header', async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(<QuestionCard item={askItem} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    expect(onAnswer).toHaveBeenCalledWith('Send test email?', 'Approve');
  });

  it('takes a free-text reply as well as an option', () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(<QuestionCard item={askItem} onAnswer={onAnswer} />);
    const input = screen.getByLabelText('Reply to this question');
    fireEvent.change(input, { target: { value: 'neither, do X' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onAnswer).toHaveBeenCalledWith('Send test email?', 'neither, do X');
  });

  it('disables a pending NATIVE question and says where to answer it', () => {
    render(
      <QuestionCard
        item={{ ...askItem, source: 'tool', answerable: false }}
        onAnswer={vi.fn()}
      />,
    );
    const approve = screen.getByRole('button', { name: /Approve/ });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Respond from Aside on your computer/)).toBeTruthy();
    // No reply box either: it could not deliver anything.
    expect(screen.queryByLabelText('Reply to this question')).toBeNull();
  });

  it('shows an answered question as history', () => {
    render(
      <QuestionCard
        item={{
          ...askItem,
          status: 'answered',
          answer: 'Send test email?: Approve',
        }}
        onAnswer={vi.fn()}
      />,
    );
    expect(screen.getByText('Send test email?: Approve')).toBeTruthy();
    expect(screen.queryByText(/Respond from Aside/)).toBeNull();
    expect(
      (screen.getByRole('button', { name: /Approve/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('renders a confirmation artifact as labelled rows, not JSON', () => {
    render(
      <QuestionCard
        item={{
          ...askItem,
          variant: 'confirm',
          artifact: {
            type: 'calendar-event-draft',
            summary: [{ label: 'title', value: 'Test Event' }],
          },
        }}
        onAnswer={vi.fn()}
      />,
    );
    expect(screen.getByText('title')).toBeTruthy();
    expect(screen.getByText('Test Event')).toBeTruthy();
  });
});

// --- deliverable 7: the task list ----------------------------------------

const todos: Todo[] = [
  { id: '1', content: 'Read the skill', status: 'completed' },
  { id: '2', content: 'Gather ground truth', status: 'in_progress' },
  { id: '3', content: 'Write the spec', status: 'pending' },
  { id: '4', content: 'Abandoned idea', status: 'cancelled' },
];

describe('the task list section', () => {
  it('summarises the in-progress item and ignores cancelled ones', () => {
    expect(todoSummary(todos)).toEqual({
      label: 'Gather ground truth',
      done: 1,
      total: 3,
    });
  });

  it('starts COLLAPSED, showing one row and a count', () => {
    render(<TodoSection todos={todos} />);
    expect(screen.getByText('Gather ground truth')).toBeTruthy();
    expect(screen.getByText('1/3')).toBeTruthy();
    // The rest are not on screen until it is opened.
    expect(screen.queryByText('Write the spec')).toBeNull();
  });

  it('expands and collapses on tap only', () => {
    render(<TodoSection todos={todos} />);
    const toggle = screen.getByRole('button');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Write the spec')).toBeTruthy();
    expect(screen.getByText('Abandoned idea')).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByText('Write the spec')).toBeNull();
  });

  it('renders nothing at all for a session that never used the tool', () => {
    const { container } = render(<TodoSection todos={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

// --- deliverable 5: the streaming footer ---------------------------------

describe('the streaming footer', () => {
  it('renders at 0s when the turn has only just started', () => {
    render(<StreamFooter startedAt={Date.now()} tokens={0} />);
    expect(screen.getByText('0s')).toBeTruthy();
    // No token count yet: "0 tokens" would be a claim, "—" is the truth.
    expect(screen.getByText('↓ —')).toBeTruthy();
  });

  it('falls back to its own clock when the turn has no timestamp yet', () => {
    // The old footer required a start time and simply did not render
    // without one, which is the "appears late or never" report.
    render(<StreamFooter startedAt={null} tokens={0} />);
    expect(screen.getByText('0s')).toBeTruthy();
  });

  it('shows the token count once it is known', () => {
    render(<StreamFooter startedAt={Date.now() - 5_000} tokens={506} />);
    expect(screen.getByText('5s')).toBeTruthy();
    expect(screen.getByText(/506 tokens/)).toBeTruthy();
  });
});

// --- deliverable 6: the stop button --------------------------------------

const composerProps = {
  variant: 'reply' as const,
  value: '',
  onChange: () => {},
  onSubmit: () => {},
  pills: { modelLabel: 'Sonnet 5', effortLabel: 'High', effortId: 'high' },
  onOpenModel: () => {},
  onOpenEffort: () => {},
  onOpenPermission: () => {},
  permissionMode: 'guard',
  attachments: [] as ComposerAttachment[],
  onAddFiles: () => {},
  onRemoveAttachment: () => {},
};

describe('the composer stop control', () => {
  it('is absent when nothing is running', () => {
    render(<Composer {...composerProps} onStop={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('appears while streaming and fires', () => {
    const onStop = vi.fn();
    render(<Composer {...composerProps} streaming onStop={onStop} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalled();
  });

  it('holds itself while the stop is in flight', () => {
    render(<Composer {...composerProps} streaming stopping onStop={() => {}} />);
    const stop = screen.getByRole('button', { name: 'Stop' }) as HTMLButtonElement;
    expect(stop.disabled).toBe(true);
  });

  it('disables input and explains itself on a suspended session', () => {
    render(
      <Composer
        {...composerProps}
        value="hello?"
        blockedReason="Waiting on a question that can only be answered from Aside on your computer."
      />,
    );
    expect(screen.getByText(/only be answered from Aside/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('renders the task list above itself', () => {
    render(<Composer {...composerProps} above={<TodoSection todos={todos} />} />);
    expect(screen.getByText('Gather ground truth')).toBeTruthy();
  });
});

// --- deliverable 8: real brand marks -------------------------------------

describe('provider marks', () => {
  it('has a real mark for every provider our catalog ships', () => {
    for (const id of ['claude-code', 'openai-codex', 'xai-grok-oauth', 'aside']) {
      expect(hasProviderMark(id)).toBe(true);
    }
  });

  it('falls back to the cluster glyph, as the desktop picker does', () => {
    // Cerebras among them: the shipped bundle names it but ships no icon.
    expect(hasProviderMark('cerebras-ai')).toBe(false);
    const { container } = render(<ProviderMark id="cerebras-ai" />);
    expect(container.querySelectorAll('path')).toHaveLength(6);
  });

  it('inherits colour rather than baking one in', () => {
    const { container } = render(<ProviderMark id="claude-code" />);
    const paths = [...container.querySelectorAll('path')];
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.getAttribute('fill')).toBe('currentColor');
    }
  });

  it('honours the size it is given', () => {
    const { container } = render(<ProviderMark id="aside" size={22} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('22');
    expect(svg.getAttribute('height')).toBe('22');
  });
});
