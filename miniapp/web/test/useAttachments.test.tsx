/**
 * Attachments, driven through a real React render and a real file input.
 *
 * This suite exists because of a specific escape. `useAttachments.add`
 * collected the files to upload INSIDE a `setItems` updater and looped over
 * them on the next line. React does not run an updater synchronously, so
 * the loop always saw an empty list: `api.upload` was never called, `fetch`
 * was provably never invoked, every chip sat at "uploading" forever, and
 * Send stayed disabled. The upload endpoint had good tests -- but they
 * called it over HTTP, with no component in the loop, so none of them could
 * see it.
 *
 * So the assertions here are deliberately about the CLIENT PATH rather than
 * the endpoint: that picking a file causes a real `fetch`, and that the
 * chip reaches "ready". Every test drives the actual `<input type="file">`
 * with a change event, exactly as the OS picker does.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../src/components/Composer';
import { useAttachments } from '../src/hooks/useAttachments';
import { setAuthToken } from '../src/api';

/** jsdom has no object-URL support and no File.arrayBuffer worth speaking of. */
beforeEach(() => {
  setAuthToken('test-token');
  let n = 0;
  globalThis.URL.createObjectURL = vi.fn(() => `blob:mock/${(n += 1)}`);
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * A fetch stub that records calls and answers the upload endpoint.
 *
 * It echoes the uploaded file's own name, because the real server does --
 * the chip is relabelled with the sanitized name it came back as.
 *
 * `gate` holds every response open until released, which is the only way to
 * observe the in-flight state: `act` flushes microtasks, so an immediately
 * resolved mock is already "ready" by the time the next line runs.
 */
function mockFetch(
  respond: (path: string, name: string) => { status: number; body: unknown } = (
    _path,
    name,
  ) => ({
    status: 200,
    body: {
      files: [
        { path: `/uploads/20260727/abc123-${name}`, name, size: 4, mimeType: 'image/png' },
      ],
    },
  }),
  gate?: Promise<void>,
) {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: any, init: any = {}) => {
    const path = String(input);
    calls.push({ path, method: init.method || 'GET', body: init.body });
    const sent = (init.body as FormData)?.get?.('files') as File | null;
    if (gate) await gate;
    const { status, body } = respond(path, sent?.name || 'file');
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'x',
      text: async () => JSON.stringify(body),
    } as any;
  });
  globalThis.fetch = fetchMock as any;
  return { calls, fetchMock };
}

const file = (name: string, type = 'image/png', size = 4) => {
  const f = new File(['x'.repeat(size)], name, { type });
  // jsdom computes size from the parts; override for the cap tests.
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

/**
 * A composer wired to the real hook, i.e. the same wiring App.tsx uses.
 * `variant` covers the two entry points -- the home card and a thread's
 * reply bar, the latter passing a sessionId to the upload.
 */
function Harness({
  variant = 'home',
  sessionId,
  onState,
}: {
  variant?: 'home' | 'reply';
  sessionId?: string;
  onState?: (state: ReturnType<typeof useAttachments>) => void;
}) {
  const attachments = useAttachments();
  onState?.(attachments);
  return (
    <Composer
      variant={variant}
      value=""
      onChange={() => {}}
      onSubmit={() => {}}
      pills={{ modelLabel: 'Sonnet 5', effortLabel: 'High', effortId: 'high' }}
      onOpenModel={() => {}}
      onOpenEffort={() => {}}
      onOpenPermission={() => {}}
      permissionMode="guard"
      attachments={attachments.items}
      onAddFiles={(files) => attachments.add(files, sessionId)}
      onRemoveAttachment={attachments.remove}
    />
  );
}

/** Fire the change event the OS picker fires, without wrapping it in act. */
function pickSync(files: File[]) {
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  expect(input).toBeTruthy();
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/** The same, flushed. */
async function pick(files: File[]) {
  await act(async () => {
    pickSync(files);
  });
}

describe('picking a file actually uploads it', () => {
  /**
   * THE regression test, and the one worth understanding.
   *
   * The broken version collected the upload list inside a `setItems`
   * updater. That does not fail every time, which is what made it so easy
   * to ship: React *eagerly* computes the next state -- synchronously --
   * for the first update on a hook whose queue is empty, purely so it can
   * bail out early if the value is unchanged. So the very first pick after
   * a render happened to work, and every pick queued behind another update
   * silently did nothing.
   *
   * Two picks in one batch is therefore the deterministic form: the second
   * updater is queued behind the first, is not eagerly evaluated, and its
   * file is never uploaded. Against the broken code this test reliably sees
   * one fetch instead of two; the single-pick tests below pass even when
   * broken, which is exactly how the owner ended up finding this in a
   * browser rather than us finding it here.
   */
  it('uploads a file picked while another update is already queued', async () => {
    const { fetchMock } = mockFetch();
    render(<Harness />);

    await act(async () => {
      pickSync([file('first.png')]);
      pickSync([file('second.png')]);
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(document.querySelectorAll('.chip')).toHaveLength(2);
    await waitFor(() => {
      expect(document.querySelector('.chip.is-uploading')).toBeNull();
    });
  });

  it('calls fetch and moves the chip from uploading to ready', async () => {
    const { calls, fetchMock } = mockFetch();
    render(<Harness />);

    await pick([file('shot.png')]);

    // The chip is there immediately, mid-flight.
    expect(screen.getByText('shot.png')).toBeTruthy();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(calls[0].path).toBe('/api/attachments');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toBeInstanceOf(FormData);
    expect((calls[0].body as FormData).getAll('files')).toHaveLength(1);

    await waitFor(() => {
      expect(document.querySelector('.chip.is-uploading')).toBeNull();
    });
    expect(document.querySelector('.chip.is-failed')).toBeNull();
  });

  it('exposes the stored path so a send can carry it', async () => {
    mockFetch();
    let state: ReturnType<typeof useAttachments> | undefined;
    render(<Harness onState={(s) => { state = s; }} />);

    await pick([file('shot.png')]);
    await waitFor(() => expect(state!.readyPaths()).toHaveLength(1));
    expect(state!.readyPaths()[0]).toBe('/uploads/20260727/abc123-shot.png');
  });

  /**
   * Send is gated on having something to send. With the bug the chip never
   * left "uploading", so the button stayed disabled forever -- which is how
   * the owner experienced it.
   */
  it('re-enables Send once the upload lands', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    mockFetch(undefined, gate);
    render(<Harness />);
    const send = () => screen.getByLabelText('Send') as HTMLButtonElement;

    expect(send().disabled).toBe(true);
    await pick([file('shot.png')]);
    // Still disabled while in flight: a half-uploaded file must not be sent.
    expect(send().disabled).toBe(true);
    expect(document.querySelector('.chip.is-uploading')).toBeTruthy();

    await act(async () => { release(); });
    await waitFor(() => expect(send().disabled).toBe(false));
  });

  /** The thread composer scopes the upload to its session. */
  it('uses the session-scoped endpoint from a thread', async () => {
    const { calls, fetchMock } = mockFetch();
    render(<Harness variant="reply" sessionId="abc123XYZ" />);

    await pick([file('note.txt', 'text/plain')]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(calls[0].path).toBe('/api/sessions/abc123XYZ/attachments');
  });

  it('uploads every picked file, one request each', async () => {
    const { fetchMock } = mockFetch();
    render(<Harness />);

    await pick([file('a.png'), file('b.png'), file('c.png')]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it('sends the bearer token', async () => {
    mockFetch();
    render(<Harness />);
    await pick([file('shot.png')]);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    const init = (globalThis.fetch as any).mock.calls[0][1];
    expect(init.headers.get('authorization')).toBe('Bearer test-token');
    // The browser must set the multipart boundary itself.
    expect(init.headers.get('content-type')).toBeNull();
  });
});

describe('failure and limits', () => {
  it('marks a chip failed when the server rejects it', async () => {
    mockFetch(() => ({ status: 413, body: { error: 'file_too_large' } }));
    render(<Harness />);

    await pick([file('big.bin', 'application/octet-stream')]);

    await waitFor(() => {
      expect(document.querySelector('.chip.is-failed')).toBeTruthy();
    });
    // One bad file does not block the composer's other state.
    expect(document.querySelector('.chip.is-uploading')).toBeNull();
  });

  it('rejects an oversize file locally, without a request', async () => {
    const { fetchMock } = mockFetch();
    render(<Harness />);

    await pick([file('huge.bin', 'application/octet-stream', 21 * 1024 * 1024)]);

    expect(document.querySelector('.chip.is-failed')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * The cap has to hold across separate picks, which is why it is tracked
   * on a ref rather than read from `prev` inside the updater.
   */
  it('caps at five files across successive picks', async () => {
    const { fetchMock } = mockFetch();
    render(<Harness />);

    await pick([file('a.png'), file('b.png'), file('c.png')]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    await pick([file('d.png'), file('e.png'), file('f.png'), file('g.png')]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    expect(document.querySelectorAll('.chip')).toHaveLength(5);
    // And a further pick does nothing at all.
    await pick([file('h.png')]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('frees a slot when a chip is removed', async () => {
    const { fetchMock } = mockFetch();
    render(<Harness />);

    await pick([file('a.png'), file('b.png'), file('c.png'), file('d.png'), file('e.png')]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));

    await act(async () => {
      (screen.getByLabelText('Remove a.png') as HTMLButtonElement).click();
    });
    expect(document.querySelectorAll('.chip')).toHaveLength(4);

    await pick([file('f.png')]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));
  });

  it('lets the same file be picked twice in a row', async () => {
    const { fetchMock } = mockFetch();
    render(<Harness />);

    await pick([file('same.png')]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // The input resets its value on change, so a repeat pick still fires.
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.value).toBe('');

    await pick([file('same.png')]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(document.querySelectorAll('.chip')).toHaveLength(2);
  });
});
