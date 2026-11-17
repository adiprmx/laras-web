import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import App from './App';
import { strings } from './strings/id';

describe('App (P0 skeleton)', () => {
  it('menampilkan judul kosong yang jujur tanpa data contoh', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain(strings.homeEmptyTitle);
    expect(html).toContain(strings.appName);
    expect(html).toContain(strings.searchNotReady);
  });

  it('tidak menampilkan kata terlarang di copy pengguna', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html.toLowerCase()).not.toContain('cache');
    expect(html).not.toContain('spike');
    expect(html).not.toContain('resolve');
  });
});
