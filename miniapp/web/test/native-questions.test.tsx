/**
 * The way out of a bricked session, on the client.
 *
 * A pending NATIVE question can only be answered from the Aside desktop
 * sidepanel. The card used to say so and stop there, which is honest and
 * useless. It now offers the one thing that can actually work: a new
 * session seeded with the question and the option the user picked.
 *
 * Also here: the permission switch, which must never again describe itself
 * as the daemon's "Final confirm" on a session driven from a phone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QuestionCard } from '../src/components/QuestionCard';
import { PermissionPicker } from '../src/components/Pickers';
import type { QuestionItem } from '../src/types';

afterEach(cleanup);

const nativeItem: QuestionItem = {
  kind: 'question',
  id: 'q-1',
  variant: 'ask',
  // The combination that means "stuck": a native tool, pending, and
  // unanswerable from here.
  source: 'tool',
  status: 'pending',
  answerable: false,
  questions: [
    {
      header: 'Send test email?',
      question: 'Approve sending it?',
      options: [
        { label: 'Approve', description: 'Send the test email now' },
        { label: 'Deny', description: 'Hold off' },
      ],
    },
  ],
};

describe('the recovery affordance on a stuck question', () => {
  it('offers a way forward instead of a dead end', () => {
    render(<QuestionCard item={nativeItem} onRecover={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: /Continue in a new session/ }),
    ).toBeTruthy();
    expect(screen.getByText(/carry on in a new session/)).toBeTruthy();
  });

  it('makes the options tappable again -- as the seed, not as an answer', () => {
    const onRecover = vi.fn().mockResolvedValue(undefined);
    render(<QuestionCard item={nativeItem} onRecover={onRecover} />);
    const approve = screen.getByRole('button', { name: /Approve/ });
    expect((approve as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(approve);
    expect(onRecover).toHaveBeenCalledWith('Approve');
  });

  it('never routes a native question through the answer path', () => {
    // Sending an answer to a suspended session is what hangs a driver, so
    // the card must not call `onAnswer` even when one is supplied.
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    const onRecover = vi.fn().mockResolvedValue(undefined);
    render(
      <QuestionCard
        item={nativeItem}
        onAnswer={onAnswer}
        onRecover={onRecover}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    expect(onAnswer).not.toHaveBeenCalled();
    expect(onRecover).toHaveBeenCalledWith('Approve');
  });

  it('takes a free-text seed too', () => {
    const onRecover = vi.fn().mockResolvedValue(undefined);
    render(<QuestionCard item={nativeItem} onRecover={onRecover} />);
    const input = screen.getByLabelText('Reply to this question');
    fireEvent.change(input, { target: { value: 'neither, do X' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onRecover).toHaveBeenCalledWith('neither, do X');
  });

  it('carries on with no option chosen at all', () => {
    const onRecover = vi.fn().mockResolvedValue(undefined);
    render(<QuestionCard item={nativeItem} onRecover={onRecover} />);
    fireEvent.click(
      screen.getByRole('button', { name: /Continue in a new session/ }),
    );
    expect(onRecover).toHaveBeenCalledWith('');
  });

  it('stays the honest dead end when there is no recovery to offer', () => {
    render(<QuestionCard item={nativeItem} onAnswer={vi.fn()} />);
    expect(
      screen.queryByRole('button', { name: /Continue in a new session/ }),
    ).toBeNull();
    expect(screen.getByText(/Respond from Aside on your computer/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /Approve/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('does not offer recovery on a question already answered', () => {
    render(
      <QuestionCard
        item={{ ...nativeItem, status: 'answered', answer: 'Approve' }}
        onRecover={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole('button', { name: /Continue in a new session/ }),
    ).toBeNull();
  });

  it('does not offer recovery on a soft-marker question, which just works', () => {
    render(
      <QuestionCard
        item={{ ...nativeItem, source: 'marker', answerable: true }}
        onAnswer={vi.fn()}
        onRecover={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole('button', { name: /Continue in a new session/ }),
    ).toBeNull();
  });
});

describe('the permission popover’s confirm switch', () => {
  const props = {
    anchor: null,
    options: [{ id: 'guard', label: 'Guard' }],
    current: 'guard',
    onPickMode: vi.fn(),
    onClose: vi.fn(),
  };

  it('no longer claims to be the daemon’s final confirm', () => {
    render(
      <PermissionPicker
        {...props}
        finalConfirm={false}
        softConfirm
        onToggleConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText('Confirm before acting')).toBeTruthy();
    expect(screen.queryByText('Final confirm')).toBeNull();
    // The whole point: it asks somewhere the phone can answer.
    expect(screen.getByText(/on a card you can answer/)).toBeTruthy();
  });

  it('keeps the plain note on a session started at the desk', () => {
    render(
      <PermissionPicker
        {...props}
        finalConfirm={false}
        softConfirm={false}
        onToggleConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText('Applies from your next message.')).toBeTruthy();
  });

  it('reflects and toggles the switch', () => {
    const onToggleConfirm = vi.fn();
    render(
      <PermissionPicker
        {...props}
        finalConfirm
        softConfirm
        onToggleConfirm={onToggleConfirm}
      />,
    );
    // `hidden: true` because the popover renders invisible until it has
    // measured its anchor, and there is no anchor in a unit test.
    const sw = screen.getByRole('switch', { hidden: true });
    expect(sw.getAttribute('aria-label')).toBe('Confirm before acting');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    expect(onToggleConfirm).toHaveBeenCalledWith(false);
  });
});
