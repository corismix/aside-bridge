/**
 * The home screen's resting state.
 *
 * The greeting is the only text on an otherwise empty screen, so a band
 * that lands wrong is very visible. It is a pure function of the hour for
 * exactly this reason: the boundaries are asserted rather than eyeballed.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RestCue, RestHero, greetingFor } from '../src/components/Rest';
import { pillModelLabel } from '../src/utils/pills';

function at(hour: number): Date {
  const d = new Date(2026, 7, 2, hour, 30, 0);
  return d;
}

describe('greetingFor', () => {
  it('covers every hour of the day without a gap', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      expect(greetingFor('Alex', at(hour))).toBeTruthy();
    }
  });

  it('uses the late-night band before 5am', () => {
    expect(greetingFor('Alex', at(1))).toBe('Up late, Alex?');
    expect(greetingFor('Alex', at(4))).toBe('Up late, Alex?');
  });

  it('switches at each boundary', () => {
    expect(greetingFor('Alex', at(5))).toBe('Early start, Alex');
    expect(greetingFor('Alex', at(9))).toBe('Morning, Alex');
    expect(greetingFor('Alex', at(12))).toBe('Afternoon, Alex');
    expect(greetingFor('Alex', at(17))).toBe('Evening, Alex');
    expect(greetingFor('Alex', at(21))).toBe('Still up, Alex?');
  });

  it('drops the name cleanly when there is not one', () => {
    // No dangling comma, and no "undefined" leaking onto the screen.
    for (const name of [undefined, '', '   ']) {
      const text = greetingFor(name, at(13));
      expect(text).toBe('Good afternoon');
      expect(text).not.toContain(',');
      expect(text).not.toContain('undefined');
    }
  });
});

describe('RestHero', () => {
  it('renders the greeting as the screen heading', () => {
    render(<RestHero name="Alex" />);
    expect(
      screen.getByRole('heading', { level: 1 }).textContent,
    ).toContain('Alex');
  });
});

describe('RestCue', () => {
  it('stays hidden when there is no history to reveal', () => {
    const { container } = render(<RestCue count={0} onOpen={() => {}} />);
    expect(container.querySelector('.rest-cue')).toBeNull();
  });

  it('appears once there is something below', () => {
    render(<RestCue count={3} onOpen={() => {}} />);
    expect(screen.getByText('Recents')).toBeTruthy();
  });
});

describe('pillModelLabel', () => {
  it('drops a trailing qualifier so the pill names the model', () => {
    // "DeepSee…" named nothing; the qualifier is the part worth losing.
    expect(pillModelLabel('DeepSeek V4 Flash (Free)')).toBe('DeepSeek V4 Flash');
    expect(pillModelLabel('Nemotron 3 Ultra (Nvidia)')).toBe('Nemotron 3 Ultra');
    expect(pillModelLabel('oc/deepseek-v4-flash-free(max)')).toBe(
      'oc/deepseek-v4-flash-free',
    );
  });

  it('leaves names without a qualifier untouched', () => {
    for (const name of ['Opus 5', 'GLM 5.2', 'Sonnet 4.6', 'gpt-5.5']) {
      expect(pillModelLabel(name)).toBe(name);
    }
  });

  it('never returns an empty pill', () => {
    // A label that is only a parenthetical would otherwise vanish.
    expect(pillModelLabel('(Free)')).toBe('(Free)');
    expect(pillModelLabel('')).toBe('');
  });

  it('only strips the LAST parenthetical', () => {
    expect(pillModelLabel('Foo (v2) Bar (Free)')).toBe('Foo (v2) Bar');
  });
});
