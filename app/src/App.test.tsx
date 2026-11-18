import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import App from './App';
import { strings } from './strings/id';

describe('App (P4: beranda + navigasi utama)', () => {
  it('menampilkan nama aplikasi dan navigasi utama', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain(strings.appName);
    expect(html).toContain('data-testid="bottom-nav"');
    expect(html).toContain('data-testid="nav-home"');
    expect(html).toContain('data-testid="nav-search"');
    expect(html).toContain('data-testid="nav-library"');
  });

  it('tidak menampilkan kata terlarang di copy pengguna', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html.toLowerCase()).not.toContain('cache');
    expect(html).not.toContain('spike');
    expect(html).not.toContain('resolve');
  });
});
