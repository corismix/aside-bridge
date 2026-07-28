/**
 * Permission mode and the final-confirm toggle.
 *
 * Both facts these tests pin were checked against the live daemon before
 * the code was written:
 *
 *  - `permissionMode` is a Zod enum of exactly three values. `aside.sessions
 *    .update(id, {permissionMode: 'bogus-mode'})` is rejected outright.
 *  - `runtimeConfig` deep-merges: sending `{finalConfirm:false}` alone left
 *    `proactiveMode`, `strictModelSelection` and `workingDirs` intact.
 *
 * The writer still does read-modify-write and sends the FULL config back.
 * Merge semantics are an undocumented property of a self-updating binary,
 * and a replace-shaped daemon would silently wipe the owner's working
 * directories. Read-modify-write is correct under both, and the sibling
 * test below is what guarantees it.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  PERMISSION_MENU,
  PERMISSION_MODES,
  applyPermission,
  isPermissionMode,
  mergeRuntimeConfig,
  updateExpression,
} from '../src/permission.js';
import { FacadeCache } from '../src/facade.js';

/** A facade whose every call is recorded rather than spawned. */
function recordingFacade() {
  const calls: string[] = [];
  const cache = new FacadeCache({
    asideCli: '/bin/false',
    runFn: async (expression) => {
      calls.push(expression);
      return null;
    },
  });
  return { cache, calls };
}

describe('permission modes', () => {
  it('offers exactly the daemon’s enum, in Aside’s order', () => {
    expect(PERMISSION_MODES).toEqual(['read-only', 'guard', 'full-access']);
    expect(PERMISSION_MENU.map((m) => m.id)).toEqual([
      'read-only',
      'guard',
      'full-access',
    ]);
    expect(PERMISSION_MENU.map((m) => m.label)).toEqual([
      'Read only',
      'Guard',
      'Full access',
    ]);
  });

  it('rejects anything the daemon would reject', () => {
    expect(isPermissionMode('guard')).toBe(true);
    expect(isPermissionMode('full-access')).toBe(true);
    expect(isPermissionMode('read-only')).toBe(true);
    expect(isPermissionMode('bogus-mode')).toBe(false);
    expect(isPermissionMode('Full access')).toBe(false);
    expect(isPermissionMode('')).toBe(false);
    expect(isPermissionMode(null)).toBe(false);
    expect(isPermissionMode(undefined)).toBe(false);
  });
});

describe('mergeRuntimeConfig', () => {
  /**
   * The whole point. A partial write must not be able to lose a key the
   * owner set in the browser.
   */
  it('preserves every sibling key', () => {
    const current = {
      memoryExtractionDisabled: false,
      proactiveMode: true,
      strictModelSelection: true,
      finalConfirm: true,
      takeScreenshotOnEverySnapshot: false,
      workingDirs: ['/Users/me/project', '/Users/me/other'],
    };
    const merged = mergeRuntimeConfig(current, { finalConfirm: false });

    expect(merged).toEqual({ ...current, finalConfirm: false });
    expect(merged.workingDirs).toEqual(current.workingDirs);
    expect(merged.proactiveMode).toBe(true);
    expect(Object.keys(merged).sort()).toEqual(Object.keys(current).sort());
  });

  it('does not mutate the config it was handed', () => {
    const current = { finalConfirm: true, proactiveMode: false };
    mergeRuntimeConfig(current, { finalConfirm: false });
    expect(current.finalConfirm).toBe(true);
  });

  it('copes with an unreadable current config', () => {
    expect(mergeRuntimeConfig(null, { finalConfirm: true })).toEqual({
      finalConfirm: true,
    });
  });
});

describe('updateExpression', () => {
  it('builds a single call, with both fields when both change', () => {
    expect(
      updateExpression('abc123', {
        permissionMode: 'guard',
        runtimeConfig: { finalConfirm: true },
      }),
    ).toBe(
      'aside.sessions.update("abc123", {"permissionMode":"guard","runtimeConfig":{"finalConfirm":true}})',
    );
  });

  /** The id is interpolated into evaluated JS, so it is a JSON literal. */
  it('escapes the session id rather than concatenating it', () => {
    const expr = updateExpression('a"); evil(); //', { permissionMode: 'guard' });
    expect(expr).toContain('"a\\"); evil(); //"');
    expect(expr.startsWith('aside.sessions.update("a\\"')).toBe(true);
  });
});

describe('applyPermission', () => {
  it('sends the mode alone when only the mode changed', async () => {
    const { cache, calls } = recordingFacade();
    const readRuntimeConfig = vi.fn(async () => ({ finalConfirm: true }));

    const patch = await applyPermission(
      { facade: cache, readRuntimeConfig },
      'sess1',
      { mode: 'read-only' },
    );

    expect(patch).toEqual({ permissionMode: 'read-only' });
    expect(calls).toEqual([
      'aside.sessions.update("sess1", {"permissionMode":"read-only"})',
    ]);
    // No config was read, because none was going to be written.
    expect(readRuntimeConfig).not.toHaveBeenCalled();
  });

  it('reads the current config before touching finalConfirm', async () => {
    const { cache, calls } = recordingFacade();
    const current = {
      proactiveMode: true,
      finalConfirm: true,
      workingDirs: ['/w'],
    };

    await applyPermission(
      { facade: cache, readRuntimeConfig: async () => current },
      'sess1',
      { finalConfirm: false },
    );

    expect(calls).toHaveLength(1);
    const sent = JSON.parse(
      calls[0].slice(calls[0].indexOf(', ') + 2, -1),
    ) as any;
    expect(sent.runtimeConfig).toEqual({
      proactiveMode: true,
      finalConfirm: false,
      workingDirs: ['/w'],
    });
    expect(sent.permissionMode).toBeUndefined();
  });

  it('applies both fields in one call so they cannot half-apply', async () => {
    const { cache, calls } = recordingFacade();
    await applyPermission(
      { facade: cache, readRuntimeConfig: async () => ({ proactiveMode: true }) },
      'sess1',
      { mode: 'full-access', finalConfirm: true },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('"permissionMode":"full-access"');
    expect(calls[0]).toContain('"finalConfirm":true');
    expect(calls[0]).toContain('"proactiveMode":true');
  });

  it('does nothing at all when nothing changed', async () => {
    const { cache, calls } = recordingFacade();
    expect(
      await applyPermission(
        { facade: cache, readRuntimeConfig: async () => ({}) },
        'sess1',
        {},
      ),
    ).toEqual({});
    expect(calls).toHaveLength(0);
  });

  /** An unreadable config must not silently blank the whole object. */
  it('still writes finalConfirm when the config could not be read', async () => {
    const { cache, calls } = recordingFacade();
    await applyPermission(
      { facade: cache, readRuntimeConfig: async () => null },
      'sess1',
      { finalConfirm: true },
    );
    expect(calls[0]).toContain('"runtimeConfig":{"finalConfirm":true}');
  });
});
