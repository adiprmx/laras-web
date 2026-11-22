// @vitest-environment jsdom
/**
 * Tes VirtualList (P-Virtual).
 *
 * Inti logika jendela diuji sebagai fungsi murni (computeWindow).
 * Komponen diuji di dua mode: jsdom tanpa layout (pengukuran 0 ->
 * virtualisasi nonaktif, semua baris di-render) dan layout
 * tiruan (offsetTop/offsetHeight + getBoundingClientRect di-mock
 * -> jendela aktif, spacer muncul, scroll menggeser jendela).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import VirtualList from './VirtualList';
import { computeWindow, VIRTUAL_LIST_THRESHOLD } from './virtualList';

// React 19: tandai lingkungan tes supaya act() tidak memperingatkan.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe('computeWindow', () => {
  it('di atas: mulai 0, akhir = viewport + overscan', () => {
    expect(
      computeWindow({
        scrollTop: 0,
        viewportHeight: 800,
        itemHeight: 72,
        total: 1000,
        overscan: 10,
      }),
    ).toEqual({ start: 0, end: 22 });
  });

  it('di tengah: jendela mengikuti scroll dengan overscan dua sisi', () => {
    expect(
      computeWindow({
        scrollTop: 7200,
        viewportHeight: 800,
        itemHeight: 72,
        total: 1000,
        overscan: 10,
      }),
    ).toEqual({ start: 90, end: 122 });
  });

  it('di bawah: akhir dijepit ke total', () => {
    expect(
      computeWindow({
        scrollTop: 71000,
        viewportHeight: 800,
        itemHeight: 72,
        total: 1000,
        overscan: 10,
      }),
    ).toEqual({ start: 976, end: 1000 });
  });

  it('daftar kosong / tinggi nol -> jendela kosong', () => {
    expect(
      computeWindow({
        scrollTop: 0,
        viewportHeight: 800,
        itemHeight: 72,
        total: 0,
        overscan: 10,
      }),
    ).toEqual({ start: 0, end: 0 });
    expect(
      computeWindow({
        scrollTop: 0,
        viewportHeight: 800,
        itemHeight: 0,
        total: 100,
        overscan: 10,
      }),
    ).toEqual({ start: 0, end: 0 });
  });

  it('overscan 0: tepat viewport, tanpa baris ekstra', () => {
    expect(
      computeWindow({
        scrollTop: 720,
        viewportHeight: 720,
        itemHeight: 72,
        total: 1000,
        overscan: 0,
      }),
    ).toEqual({ start: 10, end: 20 });
  });
});

describe('VirtualList (komponen)', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  const renderList = (count: number): void => {
    const items = Array.from({ length: count }, (_, i) => i);
    act(() => {
      root = createRoot(container);
      root.render(
        <VirtualList
          items={items}
          renderItem={(item) => (
            <li key={item} data-testid={`row-${item}`}>
              Baris {item}
            </li>
          )}
          keyOf={(item) => item}
          testId="vlist"
          className="divide-y divide-white/5"
        />,
      );
    });
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.restoreAllMocks();
  });

  it('di bawah ambang: semua baris di-render, tanpa spacer', () => {
    renderList(50);
    const list = container.querySelector('[data-testid="vlist"]');
    expect(list?.querySelectorAll('li').length).toBe(50);
    expect(
      list?.querySelectorAll('li[aria-hidden="true"]').length,
    ).toBe(0);
  });

  it('di atas ambang tapi tanpa layout (jsdom): semua baris di-render', () => {
    // jsdom: offsetTop selalu 0 -> pengukuran gagal -> nonaktif.
    renderList(VIRTUAL_LIST_THRESHOLD + 50);
    const list = container.querySelector('[data-testid="vlist"]');
    expect(list?.querySelectorAll('li').length).toBe(
      VIRTUAL_LIST_THRESHOLD + 50,
    );
    expect(
      list?.querySelectorAll('li[aria-hidden="true"]').length,
    ).toBe(0);
  });
});

describe('VirtualList dengan layout tiruan', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let rectTop = 0;
  const ROW_STRIDE = 73;

  const renderList = (count: number): void => {
    const items = Array.from({ length: count }, (_, i) => i);
    act(() => {
      root = createRoot(container);
      root.render(
        <VirtualList
          items={items}
          renderItem={(item) => (
            <li
              key={item}
              data-testid={`row-${item}`}
              data-row-index={item}
            >
              Baris {item}
            </li>
          )}
          keyOf={(item) => item}
          testId="vlist"
          className="divide-y divide-white/5"
        />,
      );
    });
  };

  const rows = (): NodeListOf<HTMLLIElement> =>
    container.querySelectorAll(
      '[data-testid="vlist"] > li:not([aria-hidden="true"])',
    );

  const spacers = (): NodeListOf<HTMLLIElement> =>
    container.querySelectorAll(
      '[data-testid="vlist"] > li[aria-hidden="true"]',
    );

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    rectTop = 0;
    // Layout tiruan: stride 73px per baris.
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get() {
        const el = this as HTMLElement;
        return Number(el.dataset.rowIndex ?? 0) * ROW_STRIDE;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() {
        return 72;
      },
    });
    vi.spyOn(
      HTMLUListElement.prototype,
      'getBoundingClientRect',
    ).mockImplementation(
      () =>
        ({
          x: 0,
          y: rectTop,
          top: rectTop,
          left: 0,
          bottom: rectTop + 200 * ROW_STRIDE,
          right: 0,
          width: 0,
          height: 200 * ROW_STRIDE,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    // jsdom innerHeight default 768.
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 768,
    });
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.restoreAllMocks();
    // @ts-expect-error — hapus mock prototype.
    delete HTMLElement.prototype.offsetTop;
    // @ts-expect-error — hapus mock prototype.
    delete HTMLElement.prototype.offsetHeight;
  });

  it('hanya me-render jendela viewport + spacer bawah', () => {
    renderList(200);
    // viewport 768 / stride 73 -> 11 baris + overscan 10 = 21.
    expect(rows().length).toBe(21);
    expect(rows()[0]?.getAttribute('data-testid')).toBe('row-0');
    expect(rows()[20]?.getAttribute('data-testid')).toBe('row-20');
    expect(spacers().length).toBe(1);
    expect(spacers()[0]?.style.height).toBe(
      `${(200 - 21) * ROW_STRIDE}px`,
    );
  });

  it('scroll menggeser jendela + spacer dua sisi', async () => {
    renderList(200);
    expect(rows()[0]?.getAttribute('data-testid')).toBe('row-0');
    // Gulir 100 baris ke bawah.
    rectTop = -100 * ROW_STRIDE;
    await act(async () => {
      window.dispatchEvent(new Event('scroll'));
      await new Promise((r) => setTimeout(r, 50));
    });
    // start = 100 - overscan 10 = 90.
    expect(rows()[0]?.getAttribute('data-testid')).toBe('row-90');
    expect(
      container.querySelector('[data-testid="row-0"]'),
    ).toBeNull();
    expect(spacers().length).toBe(2);
    expect(spacers()[0]?.style.height).toBe(`${90 * ROW_STRIDE}px`);
  });
});
