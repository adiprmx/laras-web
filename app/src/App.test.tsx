import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import App from './App';
import { strings } from './strings/id';

describe('App (P2: beranda + seksi Coba pemutar)', () => {
  it('menampilkan seksi Coba pemutar dengan lima lagu nyata', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain(strings.appName);
    expect(html).toContain(strings.tryPlayerTitle);
    expect(html).toContain('Semua Tentang Kita');
    expect(html).toContain('Tak Ingin Usai');
    expect(html).toContain(strings.searchNotReady);
  });

  it('tidak menampilkan kata terlarang di copy pengguna', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html.toLowerCase()).not.toContain('cache');
    expect(html).not.toContain('spike');
    expect(html).not.toContain('resolve');
  });
});
