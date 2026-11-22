// @vitest-environment jsdom
/**
 * Tes AppLink (P-Links, Koordinator #18): <a href> semantik +
 * intercept klik kiri polos + prefetch on-intent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AppLink from './AppLink';
import {
  __resetRoutePreloads,
  registerRoutePreload,
} from '../router/prefetch';

// React 19: tandai lingkungan tes supaya act() tidak memperingatkan.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function renderLink(props: {
  to?: string;
  onNavigate: (path: string) => void;
  onBeforeNavigate?: () => void;
  prefetch?: boolean;
  ariaCurrent?: 'page';
}): HTMLAnchorElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <AppLink
        to={props.to ?? '/library'}
        onNavigate={props.onNavigate}
        onBeforeNavigate={props.onBeforeNavigate}
        prefetch={props.prefetch}
        ariaCurrent={props.ariaCurrent}
        testId="tautan-tes"
      >
        Ke Library
      </AppLink>,
    );
  });
  return container.querySelector('a')!;
}

beforeEach(() => {
  __resetRoutePreloads();
});

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  __resetRoutePreloads();
});

describe('AppLink', () => {
  it('merender <a href> dengan teks + testid', () => {
    const link = renderLink({ onNavigate: () => {} });
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/library');
    expect(link.textContent).toBe('Ke Library');
    expect(link.getAttribute('data-testid')).toBe('tautan-tes');
  });

  it('klik kiri polos dicegat -> onNavigate (default dicegah)', () => {
    const onNavigate = vi.fn();
    const onBeforeNavigate = vi.fn();
    const link = renderLink({ onNavigate, onBeforeNavigate });
    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    act(() => {
      link.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(onBeforeNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith('/library');
  });

  it('klik termodifikasi (Ctrl) TIDAK dicegat', () => {
    const onNavigate = vi.fn();
    const link = renderLink({ onNavigate });
    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
    });
    act(() => {
      link.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('klik tengah TIDAK dicegat', () => {
    const onNavigate = vi.fn();
    const link = renderLink({ onNavigate });
    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 1,
    });
    act(() => {
      link.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('fokus memicu prefetch chunk rute', () => {
    const load = vi.fn().mockResolvedValue(undefined);
    registerRoutePreload('/library', load);
    const link = renderLink({ onNavigate: () => {} });
    // link.focus() (bukan dispatch FocusEvent): React onFocus
    // mendengarkan focusin yang hanya muncul dari fokus nyata.
    act(() => {
      link.focus();
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('prefetch=false mematikan prefetch', () => {
    const load = vi.fn().mockResolvedValue(undefined);
    registerRoutePreload('/library', load);
    const link = renderLink({ onNavigate: () => {}, prefetch: false });
    act(() => {
      link.focus();
    });
    expect(load).not.toHaveBeenCalled();
  });

  it('aria-current diteruskan', () => {
    const link = renderLink({
      onNavigate: () => {},
      ariaCurrent: 'page',
    });
    expect(link.getAttribute('aria-current')).toBe('page');
  });
});
