/**
 * Attachment storage.
 *
 * The filename reaching `saveUpload` comes from a webview's file picker,
 * which takes it from the file itself -- so it is untrusted input that gets
 * joined onto a path. Most of what follows is about that.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_UPLOAD_BYTES,
  UploadError,
  dayStamp,
  promptWithAttachments,
  sanitizeFilename,
  saveUpload,
  splitAttachmentHeader,
} from '../src/uploads.js';

const temps: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniapp-uploads-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

describe('sanitizeFilename', () => {
  it('keeps an ordinary name intact', () => {
    expect(sanitizeFilename('screenshot.png')).toBe('screenshot.png');
    expect(sanitizeFilename('report-2026_final.pdf')).toBe(
      'report-2026_final.pdf',
    );
  });

  it('reduces any path to its basename', () => {
    expect(sanitizeFilename('/etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('a/b/c/photo.jpg')).toBe('photo.jpg');
    expect(sanitizeFilename('C:\\Users\\me\\notes.txt')).toBe('notes.txt');
  });

  /** The traversal cases, each of which must not survive as a separator. */
  it('cannot produce a traversal', () => {
    for (const evil of [
      '../../../etc/passwd',
      '..%2f..%2fetc',
      './../../secret',
      '....//....//x',
      '..',
      '../',
      '/../..',
    ]) {
      const safe = sanitizeFilename(evil);
      expect(safe).not.toContain('/');
      expect(safe).not.toContain('\\');
      expect(safe.startsWith('.')).toBe(false);
      expect(safe).not.toBe('..');
      // The decisive property: joining it cannot leave the root.
      const joined = path.join('/root', safe);
      expect(joined.startsWith('/root/')).toBe(true);
    }
  });

  it('strips shell metacharacters, NULs and newlines', () => {
    expect(sanitizeFilename('a;rm -rf ~.txt')).not.toMatch(/[;~ ]/);
    expect(sanitizeFilename('$(whoami).png')).not.toMatch(/[$()]/);
    expect(sanitizeFilename('a`b`c.png')).not.toContain('`');
    expect(sanitizeFilename('a|b>c<d.png')).not.toMatch(/[|<>]/);
    expect(sanitizeFilename('nul\u0000byte.png')).toBe('nulbyte.png');
    expect(sanitizeFilename('two\nlines.png')).toBe('twolines.png');
    expect(sanitizeFilename("quote'and\"dquote.png")).not.toMatch(/['"]/);
  });

  it('never returns an empty name', () => {
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeFilename('...')).toBe('file');
    expect(sanitizeFilename('///')).toBe('file');
    expect(sanitizeFilename(null)).toBe('file');
    expect(sanitizeFilename(undefined)).toBe('file');
    expect(sanitizeFilename('\u0000\u0001')).toBe('file');
  });

  it('caps the length but keeps the extension', () => {
    const name = sanitizeFilename(`${'x'.repeat(400)}.png`);
    expect(name.length).toBeLessThanOrEqual(96);
    expect(name.endsWith('.png')).toBe(true);
  });
});

describe('saveUpload', () => {
  it('writes into a dated directory with a random prefix', () => {
    const root = tempDir();
    const saved = saveUpload(
      root,
      'photo.png',
      Buffer.from('bytes'),
      'image/png',
      new Date(2026, 6, 25),
    );

    expect(saved.path.startsWith(path.join(root, '20260725'))).toBe(true);
    expect(path.basename(saved.path)).toMatch(/^[0-9a-f]{12}-photo\.png$/);
    expect(fs.readFileSync(saved.path, 'utf8')).toBe('bytes');
    expect(saved.size).toBe(5);
    expect(saved.mimeType).toBe('image/png');
  });

  it('never lets one upload overwrite another', () => {
    const root = tempDir();
    const a = saveUpload(root, 'same.png', Buffer.from('first'));
    const b = saveUpload(root, 'same.png', Buffer.from('second'));
    expect(a.path).not.toBe(b.path);
    expect(fs.readFileSync(a.path, 'utf8')).toBe('first');
    expect(fs.readFileSync(b.path, 'utf8')).toBe('second');
  });

  it('stays inside the root even for a hostile name', () => {
    const root = tempDir();
    const saved = saveUpload(root, '../../../../tmp/pwned.sh', Buffer.from('x'));
    expect(saved.path.startsWith(root + path.sep)).toBe(true);
    expect(fs.existsSync('/tmp/pwned.sh')).toBe(false);
  });

  it('keeps the directories private', () => {
    const root = tempDir();
    const saved = saveUpload(root, 'a.txt', Buffer.from('x'));
    const dirMode = fs.statSync(path.dirname(saved.path)).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
  });

  it('rejects a file over the 20 MB cap', () => {
    const root = tempDir();
    expect(() =>
      saveUpload(root, 'big.bin', Buffer.alloc(MAX_UPLOAD_BYTES + 1)),
    ).toThrow(UploadError);
    // Nothing was written.
    expect(fs.readdirSync(root)).toHaveLength(0);
  });

  it('rejects an empty file', () => {
    expect(() => saveUpload(tempDir(), 'empty.txt', Buffer.alloc(0))).toThrow(
      /empty/,
    );
  });

  it('stamps the local day', () => {
    expect(dayStamp(new Date(2026, 0, 2))).toBe('20260102');
    expect(dayStamp(new Date(2026, 11, 31))).toBe('20261231');
  });
});

/**
 * The prompt prefix. This exact shape is what the Python bridge already
 * sends for Telegram photos, and it is what makes the agent open the files
 * locally rather than ask the user to paste them.
 */
describe('promptWithAttachments', () => {
  it('prepends the paths ahead of the user’s text', () => {
    expect(promptWithAttachments('look at this', ['/a/one.png'])).toBe(
      '[user sent 1 file from their phone, saved to: /a/one.png] look at this',
    );
  });

  it('lists several files, comma separated', () => {
    expect(
      promptWithAttachments('compare these', ['/a/one.png', '/a/two.pdf']),
    ).toBe(
      '[user sent 2 files from their phone, saved to: /a/one.png, /a/two.pdf] compare these',
    );
  });

  it('works with no text at all', () => {
    expect(promptWithAttachments('', ['/a/one.png'])).toBe(
      '[user sent 1 file from their phone, saved to: /a/one.png]',
    );
  });

  it('is a no-op without attachments', () => {
    expect(promptWithAttachments('just words', [])).toBe('just words');
    expect(promptWithAttachments('  padded  ', [])).toBe('padded');
  });
});

/**
 * Undoing the header for display.
 *
 * The header must be in the prompt (it is how the agent finds the files)
 * and must not be in the UI. On a live run before this existed, the user's
 * own bubble and the session-list title both read
 * `[user sent 2 files from their phone, saved to: /Users/…]`.
 */
describe('splitAttachmentHeader', () => {
  it('strips the header and recovers the picked filenames', () => {
    const { text, files } = splitAttachmentHeader(
      '[user sent 2 files from their phone, saved to: ' +
        '/Users/me/.aside/u/0/bridge/miniapp-uploads/20260727/3a385797c7f6-facts.txt, ' +
        '/Users/me/.aside/u/0/bridge/miniapp-uploads/20260727/837a2a9b7b38-notes.txt] ' +
        'what do you make of these',
    );
    expect(text).toBe('what do you make of these');
    // The random collision prefix is not part of what the user picked.
    expect(files).toEqual([{ name: 'facts.txt' }, { name: 'notes.txt' }]);
  });

  it('handles the singular form and an empty body', () => {
    const { text, files } = splitAttachmentHeader(
      '[user sent 1 file from their phone, saved to: /a/b/aabbccddeeff-shot.png]',
    );
    expect(text).toBe('');
    expect(files).toEqual([{ name: 'shot.png' }]);
  });

  it('leaves an ordinary message alone', () => {
    expect(splitAttachmentHeader('just a question')).toEqual({
      text: 'just a question',
      files: [],
    });
  });

  /** A header-looking string mid-message is not a header. */
  it('only strips a header at the very start', () => {
    const raw = 'see [user sent 1 file from their phone, saved to: /a/b.png]';
    expect(splitAttachmentHeader(raw).text).toBe(raw);
  });

  it('round-trips whatever promptWithAttachments produced', () => {
    const paths = ['/up/20260727/0123456789ab-a.png', '/up/20260727/ba9876543210-b.pdf'];
    const prompt = promptWithAttachments('compare these', paths);
    const split = splitAttachmentHeader(prompt);
    expect(split.text).toBe('compare these');
    expect(split.files.map((f) => f.name)).toEqual(['a.png', 'b.pdf']);
  });
});
