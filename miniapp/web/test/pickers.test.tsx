import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ModelSheet, ReasoningSheet } from '../src/components/ModelSheet';
import { PermissionPicker } from '../src/components/Pickers';
import { ProjectSheet } from '../src/components/ProjectSheet';
import type { CatalogProvider, AsideProject } from '../src/types';

const catalog: CatalogProvider[] = [
  {
    id: 'other-provider',
    label: 'Other Provider',
    connected: true,
    models: [{ id: 'other-model', label: 'Other Model', contextWindow: 64_000 }],
  },
  {
    id: 'openai-codex',
    label: 'OpenAI Codex',
    connected: true,
    models: [{ id: 'gpt-5.6-sol', label: 'GPT 5.6 Sol', contextWindow: 200_000 }],
  },
];

const projects: AsideProject[] = [
  { id: 'a', name: 'Workspace', icon: 'folder', color: 'sky', workspacePath: '/first/Workspace' },
  { id: 'b', name: 'Workspace', icon: 'terminal', color: 'orange', workspacePath: '/second/Workspace' },
  { id: 'c', name: 'Notes', icon: 'book', color: 'mono', workspacePath: '/notes' },
];

let originalMatchMedia: typeof window.matchMedia;

function setPhoneViewport(phone: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('639px') ? phone : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  originalMatchMedia = window.matchMedia;
  setPhoneViewport(true);
});

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
});

describe('adaptive Aside pickers', () => {
  it('shows the exact permission descriptions and default without selecting Guard when unknown', () => {
    render(
      <PermissionPicker
        anchor={null}
        options={[
          { id: 'read-only', label: 'Read only' },
          { id: 'guard', label: 'Guard' },
          { id: 'full-access', label: 'Full access' },
        ]}
        current={null}
        finalConfirm={null}
        onPickMode={vi.fn()}
        onToggleConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Can only work in this task’s folder. Won’t access other folders.')).toBeTruthy();
    expect(screen.getByText('Can work in Documents, Downloads, and this task’s folder. Asks before accessing other folders.')).toBeTruthy();
    expect(screen.getByText('Can read and write anywhere on this computer.')).toBeTruthy();
    expect(screen.getByText("Aside's default is Guard.")).toBeTruthy();
    expect(document.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(0);
    expect(screen.getByText('Asks here, on a card you can answer. Applies from your next message.')).toBeTruthy();
  });

  it('checks the actual Full access mode when the session reports it', () => {
    render(
      <PermissionPicker
        anchor={null}
        options={[
          { id: 'read-only', label: 'Read only' },
          { id: 'guard', label: 'Guard' },
          { id: 'full-access', label: 'Full access' },
        ]}
        current="full-access"
        finalConfirm={false}
        onPickMode={vi.fn()}
        onToggleConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(document.querySelector('button[aria-pressed="true"]')?.textContent).toContain('Full access');
  });

  it('shows provider groups immediately and puts the selected provider first', () => {
    render(
      <ModelSheet
        anchor={null}
        catalog={catalog}
        currentProvider="openai-codex"
        currentModel="gpt-5.6-sol"
        onPickModel={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const groups = document.querySelectorAll('.picker-group');
    expect(groups[0].textContent).toContain('OpenAI Codex');
    expect(groups[1].textContent).toContain('Other Provider');
    expect(screen.getByRole('button', { name: /GPT 5\.6 Sol/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText('More models')).toBeNull();
    expect(document.body.textContent).not.toContain('context');
  });

  it('searches all providers and normalizes the common GPT spelling', () => {
    const onPickModel = vi.fn();
    const onClose = vi.fn();
    render(
      <ModelSheet
        anchor={null}
        catalog={catalog}
        currentProvider="other-provider"
        currentModel="other-model"
        onPickModel={onPickModel}
        onClose={onClose}
      />,
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), {
      target: { value: 'gpt 5.6' },
    });
    const result = screen.getByRole('button', { name: /GPT 5\.6 Sol/ });
    fireEvent.click(result);
    expect(onPickModel).toHaveBeenCalledWith('openai-codex', 'gpt-5.6-sol');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('uses an anchored menu on tablet and desktop widths', () => {
    setPhoneViewport(false);
    const anchor = document.createElement('button');
    document.body.append(anchor);
    render(
      <ModelSheet
        anchor={anchor}
        catalog={catalog}
        currentProvider="openai-codex"
        currentModel="gpt-5.6-sol"
        onPickModel={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    anchor.remove();
  });

  it('shows project checks, omits unique paths, and distinguishes duplicate names by path', () => {
    const onPick = vi.fn();
    render(
      <ProjectSheet
        anchor={null}
        projects={projects}
        current="b"
        onPick={onPick}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('/first/Workspace')).toBeTruthy();
    expect(screen.getByText('/second/Workspace')).toBeTruthy();
    expect(screen.queryByText('/notes')).toBeNull();
    expect(screen.getByRole('button', { name: 'No project' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: /Workspace\/second\/Workspace/ }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'No project' }));
    expect(onPick).toHaveBeenCalledWith('');
  });

  it('does not advertise Ultrabrowse as selectable without account availability data', () => {
    render(
      <ReasoningSheet
        anchor={null}
        options={[
          { id: 'high', label: 'High' },
          { id: 'ultrabrowse', label: 'Ultrabrowse' },
        ]}
        current="high"
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const ultra = screen.getByRole('button', { name: /Ultrabrowse/ });
    expect((ultra as HTMLButtonElement).disabled).toBe(true);
    expect(within(ultra).getByText('Availability must be checked in Aside.')).toBeTruthy();
  });
});
