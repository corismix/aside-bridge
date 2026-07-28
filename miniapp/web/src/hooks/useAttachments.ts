/**
 * Composer attachments.
 *
 * Files start uploading the moment the OS picker returns, so the bytes are
 * on their way while the user is still typing and Send is a plain JSON
 * call carrying paths. Each file gets its own request: one failure then
 * costs one chip rather than the whole selection.
 *
 * The `path` a chip carries is whatever the server handed back, and the
 * server only accepts paths it issued itself -- a client cannot name a file
 * on the machine and have it read out to the agent.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { ComposerAttachment } from '../types';

const MAX_FILES = 5;
const MAX_BYTES = 20 * 1024 * 1024;

export interface AttachmentsState {
  items: ComposerAttachment[];
  add: (files: File[], sessionId?: string) => void;
  remove: (key: string) => void;
  clear: () => void;
  /** Chips the server has stored, in the order they were picked. */
  ready: () => ComposerAttachment[];
  readyPaths: () => string[];
}

export function useAttachments(): AttachmentsState {
  const [items, setItems] = useState<ComposerAttachment[]>([]);
  // Object URLs are a real resource; they are revoked on removal and on
  // unmount rather than left to the page's lifetime.
  const urls = useRef(new Set<string>());
  const seq = useRef(0);
  /**
   * How many chips are live.
   *
   * `add` needs the count BEFORE the state updater runs, because it decides
   * there and then which uploads to start -- so it cannot read `prev`.
   */
  const count = useRef(0);

  const revoke = (url?: string) => {
    if (!url) return;
    URL.revokeObjectURL(url);
    urls.current.delete(url);
  };

  useEffect(
    () => () => {
      for (const url of urls.current) URL.revokeObjectURL(url);
      urls.current.clear();
    },
    [],
  );

  /**
   * Take newly picked files: build their chips, then start their uploads.
   *
   * The chips and the upload list are computed HERE, in plain code, and the
   * state updater below is a pure `prev => [...prev, ...chips]`. That split
   * is the whole point of this shape, and it is load-bearing:
   *
   * The first cut collected the accepted files INSIDE the `setItems`
   * updater and looped over them immediately after the call. React does not
   * run an updater synchronously, so the loop always saw an empty list and
   * `api.upload` was never called -- every chip sat at "uploading" forever
   * and `fetch` was provably never invoked. It survived review because the
   * upload endpoint itself was only ever tested directly, over HTTP, with
   * no component in the loop. `useAttachments.test.tsx` drives a real file
   * input through React and would have caught it.
   *
   * `MAX_FILES` is therefore enforced against a ref rather than `prev`: the
   * cap has to be known before the updater runs, since it decides which
   * uploads start.
   */
  const add = useCallback((files: File[], sessionId?: string) => {
    const room = Math.max(0, MAX_FILES - count.current);
    if (room <= 0) return;

    const chips: ComposerAttachment[] = [];
    const accepted: Array<{ key: string; file: File }> = [];

    for (const file of files.slice(0, room)) {
      seq.current += 1;
      const key = `a${seq.current}`;
      let previewUrl: string | undefined;
      if (file.type.startsWith('image/')) {
        previewUrl = URL.createObjectURL(file);
        urls.current.add(previewUrl);
      }
      const tooBig = file.size > MAX_BYTES;
      chips.push({
        key,
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        previewUrl,
        status: tooBig ? 'failed' : 'uploading',
        error: tooBig ? 'Over the 20 MB limit' : undefined,
      });
      if (!tooBig) accepted.push({ key, file });
    }

    if (!chips.length) return;
    count.current += chips.length;
    setItems((prev) => [...prev, ...chips]);

    for (const { key, file } of accepted) {
      api.upload([file], sessionId).then(
        (res) => {
          const saved = res.files[0];
          setItems((prev) =>
            prev.map((item) =>
              item.key === key
                ? saved
                  ? { ...item, status: 'ready', path: saved.path, name: saved.name }
                  : { ...item, status: 'failed', error: 'Upload failed' }
                : item,
            ),
          );
        },
        (err: Error) => {
          setItems((prev) =>
            prev.map((item) =>
              item.key === key
                ? { ...item, status: 'failed', error: err.message }
                : item,
            ),
          );
        },
      );
    }
  }, []);

  const remove = useCallback((key: string) => {
    setItems((prev) => {
      const hit = prev.find((item) => item.key === key);
      if (!hit) return prev;
      revoke(hit.previewUrl);
      const next = prev.filter((item) => item.key !== key);
      count.current = next.length;
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    count.current = 0;
    setItems((prev) => {
      for (const item of prev) revoke(item.previewUrl);
      return [];
    });
  }, []);

  const ready = useCallback(
    () => items.filter((item) => item.status === 'ready' && item.path),
    [items],
  );

  return {
    items,
    add,
    remove,
    clear,
    ready,
    readyPaths: () =>
      items
        .filter((item) => item.status === 'ready' && item.path)
        .map((item) => item.path as string),
  };
}
