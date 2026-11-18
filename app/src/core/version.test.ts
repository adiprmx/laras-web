import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_BUILD, APP_VERSION } from './version';

describe('APP_VERSION', () => {
  it('sama dengan version di package.json', () => {
    // cwd Vitest adalah direktori app (tempat package.json berada).
    const pkgPath = join(process.cwd(), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      version: string;
    };
    expect(APP_VERSION).toBe(pkg.version);
  });

  it('build web selalu 0 (tidak ada build native)', () => {
    expect(APP_BUILD).toBe(0);
  });
});
