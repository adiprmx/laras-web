/**
 * Tes port `player_script.dart` (S4) - port Vitest dari
 * `laras/test/extractor/player_script_test.dart` ditambah tes terhadap
 * base.js ASLI ketiga hash yang sedang live (fad7e4e9, ad8d59ae,
 * b559f50c).
 *
 * Cuplikan fixture disalin byte-identik dari
 * `laras/test/fixtures/base-js-snippet*.js` (sha256 cocok). base.js
 * penuh dibaca dari arsip koordinator Fase 2 APK; bila berkasnya tidak
 * ada di mesin ini, grup base.js penuh dilewati dengan alasan jelas
 * (bukan gagal diam-diam).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ExtractorException } from './errors';
import {
  buildPlayerScript,
  buildSolveDriver,
  buildSolverInitScript,
  extractFunction,
  extractJsUrl,
  extractObjectLiteral,
  extractPlayerHash,
  extractSigCallSite,
  extractSignatureTimestamp,
  extractStringTable,
  extractStringTableInfo,
  parseStringTable,
  solveExpression,
} from './playerScript';

function loadFixture(name: string): string {
  // import.meta.url di bawah transform Vite menunjuk path virtual
  // (/src/...), jadi pakai cwd proyek (vitest jalan dari app/).
  return readFileSync(
    resolve(process.cwd(), 'src/solver/test-fixtures', name),
    'utf8',
  );
}

const loadSnippet = () => loadFixture('base-js-snippet.js');
const loadSnippetAd8 = () => loadFixture('base-js-snippet-ad8d59ae.js');
const loadSnippetB55 = () => loadFixture('base-js-snippet-b559f50c.js');

const kJsUrl = '/s/player/fad7e4e9/player_es6.vflset/en_US/base.js';

/** Jalur base.js asli (arsip koordinator Fase 2 APK). */
const kFullBaseJs: Record<string, string> = {
  fad7e4e9: `${process.env.HOME}/workspace/music-app/hidden_files/tim-p1-spike/base-fad7e4e9.js`,
  ad8d59ae: `${process.env.HOME}/workspace/music-app/hidden_files/koordinator-fase-2/base_ad8d59ae.js`,
  b559f50c: `${process.env.HOME}/workspace/music-app/hidden_files/koordinator-fase-2/base_b559f50c.js`,
};

function loadFullBaseJs(hash: string): string | null {
  const path = kFullBaseJs[hash];
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

/** Cuplikan base.js minimal yang valid untuk tes pengerasan Blue 4. */
function minimalJs(options: {
  middleFn?: string;
  className?: string;
  classMethods?: string;
  extra?: string;
} = {}): string {
  const middleFn =
    options.middleFn ??
    'Xm=function(a,b,c){var d=b^a;return String[w[0]](d);}';
  const className = options.className ?? 'tf';
  const classMethods =
    options.classMethods ??
    'set(a,b){}get(a){return null;}gf(){return this.u;}clone(){return this;}';
  const extra = options.extra ?? '';
  return `
signatureTimestamp:20768,
c=new g.${className}(k.url,!0);if(k.s){var f=c,h=k.sp;
let l=Xm(46,8518,Ip(4,6503,k.s));
f[w[8]](h,ld(8,476,l))
w='length;url;split;reverse;join;fromCharCode;slice;splice;set;'.split(";");
Ip=function(a,b,c){return c;}
${middleFn}
ld=function(a,b,c){return c;}
${extra}
g.${className}=class{constructor(a,b=!1){this.u=a;}${classMethods}};
`;
}

/** Template literal JS bersarang sedalam `depth` level. */
function nestedTemplate(depth: number): string {
  let inner = '`x`';
  for (let i = 1; i < depth; i++) {
    inner = '`${' + inner + '}`';
  }
  return inner;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Harapkan `fn` melempar ExtractorException penyebab unknownPlayerHash. */
function expectUnknownPlayerHash(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ExtractorException);
    expect((error as ExtractorException).cause).toBe('unknownPlayerHash');
    return;
  }
  throw new Error('diharapkan melempar unknownPlayerHash, tetapi tidak');
}

describe('ekstraksi dari cuplikan base.js fad7e4e9 (asli, 15 Nov 2026)', () => {
  it('extractJsUrl dari HTML', () => {
    const html =
      '<html><head></head><body>{"jsUrl":"/s/player/fad7e4e9/player_es6.vflset/en_US/base.js","other":1}</body></html>';
    expect(extractJsUrl(html)).toBe(kJsUrl);
    expect(extractJsUrl('<html>tanpa jsUrl</html>')).toBeNull();
  });

  it('extractPlayerHash dari jsUrl', () => {
    expect(extractPlayerHash(kJsUrl)).toBe('fad7e4e9');
    expect(extractPlayerHash('/s/player/abc123/player.js')).toBe('abc123');
    expect(extractPlayerHash('/tanpa/hash')).toBeNull();
  });

  it('extractSignatureTimestamp = 20767', () => {
    expect(extractSignatureTimestamp(loadSnippet())).toBe(20767);
  });

  it('extractStringTable menemukan tabel w', () => {
    const table = extractStringTable(loadSnippet());
    expect(table).not.toBeNull();
    expect(table).toMatch(/^w='length;/);
    expect(table).toContain('signatureCipher');
    expect(table).toContain('_w8_');
  });

  it('extractSigCallSite: uf / Ne / vf + parameter call site', () => {
    const site = extractSigCallSite(loadSnippet());
    expect(site).not.toBeNull();
    expect(site!.innerName).toBe('uf');
    expect(site!.innerA).toBe(9);
    expect(site!.innerB).toBe(8472);
    expect(site!.middleName).toBe('Ne');
    expect(site!.middleA).toBe(56);
    expect(site!.middleB).toBe(7789);
    expect(site!.outerName).toBe('vf');
    expect(site!.outerA).toBe(2);
    expect(site!.outerB).toBe(6827);
    expect(site!.helperObjectName).toBe('jB');
    expect(site!.setMethodTableIndex).toBe(8);
  });
});

describe('extractStringTable bentuk baru (rotasi 17 Nov 2026)', () => {
  it('kutip ganda + delimiter ";" (ad8d59ae)', () => {
    const snippet =
      'var a=1;w="length;url;mZ;rr?[1-9].*\\.c\\.youtube\\.com$/videoplayback;' +
      'split;;r;,;scheme;path;reverse;cmo=pf;C;set;WAaZk4;replacer;' +
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' +
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' +
      'aaaaaaaaaaaaaaaaaaaaaaaaaa".split(";");var b=2;';
    const table = extractStringTable(snippet);
    expect(table).not.toBeNull();
    expect(table).toMatch(/^w="length;/);
    expect(table).toMatch(/\.split\(";"\);$/);
  });

  it('kutip ganda + delimiter "{" (b559f50c)', () => {
    const snippet =
      'w="/initplayback{/file/index.m3u8{A{path{length{call{set{{indexOf{' +
      'toString{n{join{/videoplayback{/{B{mn{j{file{www.youtube.com{&{http:' +
      '//local{split{startsWith{splaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' +
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' +
      'aaaaaaaaaaaaaaaaaaaaaaaaaa".split("{");';
    const table = extractStringTable(snippet);
    expect(table).not.toBeNull();
    expect(table).toMatch(/^w="\/initplayback\{/);
    expect(table).toMatch(/\.split\("\{"\);$/);
  });

  it('kutip ganda + escape \\" di dalam isi tetap cocok', () => {
    const snippet =
      'w="tokenA;tokenB;teks\\"dengan\\"kutip;tokenC;tokenD;tokenE;tokenF;' +
      'tokenG;tokenH;tokenI;tokenJ;tokenK;tokenL;tokenM;tokenN;tokenO;' +
      'tokenP;tokenQ;tokenR;tokenS;tokenT;tokenU;tokenV".split(";");';
    const table = extractStringTable(snippet);
    expect(table).not.toBeNull();
    expect(table).toContain('teks\\"dengan\\"kutip');
  });

  it('tanpa tabel -> null', () => {
    expect(extractStringTable('var x = 1; function f() { return 2; }')).toBeNull();
    expect(extractStringTable('w="pendek".split(";");')).toBeNull();
  });
});

describe('ekstraksi dari cuplikan base.js fad7e4e9 (lanjutan)', () => {
  it('solveExpression merangkai rantai dengan benar', () => {
    const site = extractSigCallSite(loadSnippet());
    expect(solveExpression(site!, '__s')).toBe(
      'vf(2,6827,Ne(56,7789,uf(9,8472,__s)))',
    );
  });

  it('extractFunction mengambil badan fungsi utuh', () => {
    const snippet = loadSnippet();
    const uf = extractFunction(snippet, 'uf');
    expect(uf).not.toBeNull();
    expect(uf).toMatch(/^uf=function\(a,b,c,d\)\{/);
    expect(uf!.endsWith('}')).toBe(true);
    expect(uf).toContain('decodeURIComponent');
    const ne = extractFunction(snippet, 'Ne');
    expect(ne).not.toBeNull();
    expect(ne).toContain('jB[');
    expect(extractFunction(snippet, 'tidakAda')).toBeNull();
  });

  it('extractObjectLiteral mengambil jB utuh', () => {
    const jb = extractObjectLiteral(loadSnippet(), 'jB');
    expect(jb).not.toBeNull();
    expect(jb).toMatch(/^jB=\{/);
    expect(jb).toContain('FG:function');
    expect(jb).toContain('Gz:function');
    expect(jb).toContain('Fe:function');
  });

  it('buildPlayerScript merakit prelude lengkap', () => {
    const script = buildPlayerScript(kJsUrl, loadSnippet());
    expect(script.hash).toBe('fad7e4e9');
    expect(script.signatureTimestamp).toBe(20767);
    expect(script.sigCallSite.middleName).toBe('Ne');
    expect(script.preludeCode).toContain("w='length;");
    expect(script.preludeCode).toContain('uf=function');
    expect(script.preludeCode).toContain('Ne=function');
    expect(script.preludeCode).toContain('vf=function');
    expect(script.preludeCode).toContain('jB={');
    expect(script.urlClassName).toBe('tf');
    expect(script.urlSetMethod).toBe('set');
    expect(script.urlSerializeMethod).toBe('gf');
  });

  it('buildPlayerScript gagal bila pola tidak cocok', () => {
    expectUnknownPlayerHash(() =>
      buildPlayerScript(kJsUrl, 'var x = 1; // bukan base.js'),
    );
  });

  it('buildSolveDriver menyisipkan nilai sebagai literal JSON', () => {
    const script = buildPlayerScript(kJsUrl, loadSnippet());
    const driver = buildSolveDriver(script, {
      cipherUrl: 'https://rr1---sn-x.googlevideo.com/videoplayback?n=abc',
      cipheredS: 's-ciphered";berbahaya',
      sigParam: 'sig',
    });
    expect(driver).toContain(String.raw`\";berbahaya`);
    expect(driver).toContain('vf(2,6827,Ne(56,7789,uf(9,8472,__s)))');
    expect(driver).toContain('new _yt_player.tf(');
    expect(driver).toContain('__u.gf();');
  });

  it('buildSolverInitScript menggabung stub + sumber + prelude', () => {
    const script = buildPlayerScript(kJsUrl, loadSnippet());
    const init = buildSolverInitScript(script);
    expect(init).toContain('globalThis.document = documentStub');
    expect(init).toContain('signatureTimestamp:20767');
    expect(init).toContain('uf=function');
  });
});

describe('buildPlayerScript helper global bawaan (rotasi 17 Nov 2026)', () => {
  const kBuiltinHelperJs = `
signatureTimestamp:20768,
c=new g.tf(k.url,!0);if(k.s){var f=c,h=k.sp;
let l=Xm(46,8518,Ip(4,6503,k.s));
f[w[8]](h,ld(8,476,l))
w='length;url;split;reverse;join;fromCharCode;slice;splice;set;'.split(";");
Ip=function(a,b,c){return c;}
Xm=function(a,b,c){var d=b^a;return String[w[0]](d);}
ld=function(a,b,c){return c;}
g.tf=class{constructor(a,b=!1){this.u=a;}set(a,b){}get(a){return null;}gf(){return this.u;}clone(){return this;}};
`;
  const kJsUrlAd8 = '/s/player/ad8d59ae/player_es6.vflset/en_US/base.js';

  it('helper String (builtin) tanpa literal -> prelude tanpa helper', () => {
    const script = buildPlayerScript(kJsUrlAd8, kBuiltinHelperJs);
    expect(script.hash).toBe('ad8d59ae');
    expect(script.signatureTimestamp).toBe(20768);
    expect(script.sigCallSite.helperObjectName).toBe('String');
    expect(script.preludeCode).toContain('Xm=function');
    expect(script.preludeCode).toContain('Ip=function');
    expect(script.preludeCode).toContain('ld=function');
    expect(script.preludeCode).not.toContain('String={');
  });

  it('helper kustom tanpa literal -> tetap gagal keras', () => {
    const js = kBuiltinHelperJs.replaceAll('String[w[0]]', 'ZZ[w[0]]');
    expectUnknownPlayerHash(() => buildPlayerScript(kJsUrlAd8, js));
  });
});

describe('buildPlayerScript dependensi transitif (rotasi 17 Nov 2026)', () => {
  it('prelude ad8d59ae memuat Vm + rantai transitif', () => {
    const script = buildPlayerScript(
      '/s/player/ad8d59ae/player_es6.vflset/en_US/base.js',
      loadSnippetAd8(),
    );
    expect(script.hash).toBe('ad8d59ae');
    expect(script.signatureTimestamp).toBe(20768);
    expect(script.sigCallSite.innerName).toBe('Ip');
    expect(script.sigCallSite.middleName).toBe('Xm');
    expect(script.sigCallSite.outerName).toBe('ld');
    expect(script.sigCallSite.helperObjectName).toBe('String');
    // Ring 1: dependensi langsung rantai. Vm adalah akar bug 17 Nov:
    // Xm memanggil Vm[w[...]] tapi prelude lama tidak memuatnya.
    expect(script.preludeCode).toContain('Vm={');
    expect(script.preludeCode).toContain('bk=function');
    expect(script.preludeCode).toContain('Wm=function');
    expect(script.preludeCode).toContain('kd=function');
    // Ring 2+: transitif - Wm butuh Gn/Vz/hB, kd butuh Bp/Bd.
    expect(script.preludeCode).toContain('Gn=function');
    expect(script.preludeCode).toContain('Vz=function');
    expect(script.preludeCode).toContain('hB=function');
    expect(script.preludeCode).toContain('Bp=function');
    expect(script.preludeCode).toContain('Bd=function');
    // Ring 3+: Vz butuh Tz/Uz, Bp butuh zp, zp butuh Ela/yp.
    expect(script.preludeCode).toContain('Tz=function');
    expect(script.preludeCode).toContain('Uz=function');
    expect(script.preludeCode).toContain('zp=function');
    expect(script.preludeCode).toContain('Ela=function');
    expect(script.preludeCode).toContain('yp=function');
    // Alias parameter IIFE untuk g.jr/g.Um/g.O di Wm/kd.
    expect(script.preludeCode).toContain('var g = _yt_player;');
    // Decoy cabang mati tanpa definisi tidak ikut dimuat.
    expect(script.preludeCode).not.toContain('Taa=function');
    expect(script.preludeCode).not.toContain('Taa={');
    // Info URL ad8d59ae: kelas bs (bukan tf), serialisasi ff.
    expect(script.urlClassName).toBe('bs');
    expect(script.urlSetMethod).toBe('set');
    expect(script.urlSerializeMethod).toBe('ff');
    expect(script.sigCallSite.setMethodTableIndex).toBe(14);
  });

  it('prelude b559f50c memuat rantai transitif + helper mV', () => {
    const script = buildPlayerScript(
      '/s/player/b559f50c/player_es6.vflset/en_US/base.js',
      loadSnippetB55(),
    );
    expect(script.hash).toBe('b559f50c');
    expect(script.signatureTimestamp).toBe(20770);
    expect(script.sigCallSite.innerName).toBe('IH');
    expect(script.sigCallSite.middleName).toBe('dy');
    expect(script.sigCallSite.outerName).toBe('dy');
    expect(script.sigCallSite.helperObjectName).toBe('mV');
    expect(script.preludeCode).toContain('mV={');
    expect(script.preludeCode).toContain('ay=function');
    expect(script.preludeCode).toContain('by=function');
    expect(script.preludeCode).toContain('cy=function');
    expect(script.preludeCode).toContain('ey=function');
    expect(script.preludeCode).toContain('Iz=function');
    expect(script.preludeCode).toContain('Jz=function');
    expect(script.preludeCode).toContain('lc=function');
    expect(script.preludeCode).toContain('hha=function');
    // Fungsi yang dipakai ganda (tengah + luar) cukup sekali.
    expect(countOccurrences(script.preludeCode, '\ndy=function')).toBe(1);
    // Info URL b559f50c: kelas JH, serialisasi gf (seperti tf lama).
    expect(script.urlClassName).toBe('JH');
    expect(script.urlSetMethod).toBe('set');
    expect(script.urlSerializeMethod).toBe('gf');
    expect(script.sigCallSite.setMethodTableIndex).toBe(6);
  });

  it('buildSolveDriver memakai nama URL hasil ekstraksi', () => {
    const script = buildPlayerScript(
      '/s/player/ad8d59ae/player_es6.vflset/en_US/base.js',
      loadSnippetAd8(),
    );
    const driver = buildSolveDriver(script, {
      cipherUrl: 'https://rr1---sn-x.googlevideo.com/videoplayback?n=abc',
      cipheredS: 's-ciphered',
      sigParam: 'sig',
    });
    expect(driver).toContain('new _yt_player.bs(');
    expect(driver).toContain('__u.set(');
    expect(driver).toContain('__u.ff();');
    expect(driver).not.toContain('_yt_player.tf');
    expect(driver).not.toContain('__u.gf();');
  });

  it('parseStringTable mengurai kedua bentuk + escape', () => {
    expect(parseStringTable("w='a;b;c;'.split(\";\");")).toEqual([
      'a',
      'b',
      'c',
      '',
    ]);
    expect(parseStringTable('w="a{b{c".split("{");')).toEqual(['a', 'b', 'c']);
    expect(
      parseStringTable('w="teks\\"dengan\\"kutip;x".split(";");'),
    ).toEqual(['teks"dengan"kutip', 'x']);
    expect(parseStringTable('var x = 1;')).toBeNull();
    expect(parseStringTable('w="tanpa split";')).toBeNull();
  });

  it('pemindai referensi: lokal koma, string, properti bukan dep', () => {
    const js = `
signatureTimestamp:20799,
c=new g.tf(k.url,!0);if(k.s){var f=c,h=k.sp;
let l=Mm(10,20,Ii(3,4,k.s));
f[w[8]](h,Oo(5,6,l))
w='length;url;split;reverse;join;fromCharCode;x;y;set;'.split(";");
Ii=function(a,b,c){return c;}
Mm=function(a,b,c){var d=b^a;var e=d^1,f=[];f[w[0]](Qq[w[1]](d));var s="ZZ(1,2)";g.jr(d);return Rr(e);}
Oo=function(a,b,c){return c;}
Qq={m:function(a){return a;}};
Rr=function(a){return Ss(a);};
Ss=function(a){return a;};
f=function(a){return a;};
ZZ=function(a){return a;};
jr=function(a){return a;};
g.tf=class{constructor(a,b=!1){this.u=a;}set(a,b){}get(a){return null;}gf(){return this.u;}clone(){return this;}};
`;
    const script = buildPlayerScript(
      '/s/player/abcdef01/player_es6.vflset/en_US/base.js',
      js,
    );
    expect(script.sigCallSite.helperObjectName).toBe('Qq');
    expect(script.preludeCode).toContain('Qq={');
    expect(script.preludeCode).toContain('Rr=function');
    expect(script.preludeCode).toContain('Ss=function');
    expect(script.preludeCode).not.toContain('f=function');
    expect(script.preludeCode).not.toContain('ZZ=function');
    expect(script.preludeCode).not.toContain('jr=function');
  });
});

describe('pengerasan Blue 4 (R4-I1): cap prelude + siklus', () => {
  it('rantai 70 fungsi dipotong di cap 64 (BFS terdekat didahulukan)', () => {
    let chain = '';
    for (let i = 0; i < 70; i++) {
      if (i < 69) {
        chain += `F${i}=function(a){return F${i + 1}(a);}\n`;
      } else {
        chain += `F${i}=function(a){return a;}\n`;
      }
    }
    const script = buildPlayerScript(
      '/s/player/ad8d59ae/player_es6.vflset/en_US/base.js',
      minimalJs({
        middleFn: 'Xm=function(a,b,c){var d=String[w[0]](b);return F0(d);}',
        extra: chain,
      }),
    );
    // 3 seed (Ip/Xm/ld) + F0..F60 = tepat 64 definisi.
    expect(countOccurrences(script.preludeCode, '=function(')).toBe(64);
    expect(script.preludeCode).toContain('F60=function');
    expect(script.preludeCode).not.toContain('F61=function');
    expect(script.preludeCode).not.toContain('F69=function');
  });

  it('siklus dependensi A->B->A terminasi, masing-masing sekali', () => {
    const script = buildPlayerScript(
      '/s/player/ad8d59ae/player_es6.vflset/en_US/base.js',
      minimalJs({
        middleFn: 'Xm=function(a,b,c){var d=String[w[0]](b);return Aa(d);}',
        extra: 'Aa=function(a){return Bb(a);}\nBb=function(a){return Aa(a);}',
      }),
    );
    expect(countOccurrences(script.preludeCode, 'Aa=function')).toBe(1);
    expect(countOccurrences(script.preludeCode, 'Bb=function')).toBe(1);
  });

  it('prelude melebihi cap byte (1 MB) -> unknownPlayerHash', () => {
    const bigDef = `Big=function(a){var s="${'a'.repeat(2 * 1024 * 1024)}";return a;}`;
    expectUnknownPlayerHash(() =>
      buildPlayerScript(
        '/s/player/ad8d59ae/player_es6.vflset/en_US/base.js',
        minimalJs({
          middleFn: 'Xm=function(a,b,c){var d=String[w[0]](b);return Big(d);}',
          extra: bigDef,
        }),
      ),
    );
  });
});

describe('pengerasan Blue 4 (R4-I2): angka dan template patologis', () => {
  it('angka > int64 di grup rantai -> null (bukan pengecualian parse)', () => {
    const js = minimalJs().replace('Xm(46,8518,', 'Xm(46,99999999999999999999,');
    expect(extractSigCallSite(js)).toBeNull();
  });

  it('angka > int64 di grup luar + indeks tabel -> null', () => {
    const outerHuge = minimalJs().replace('ld(8,476,l)', 'ld(99999999999999999999,476,l)');
    expect(extractSigCallSite(outerHuge)).toBeNull();
    const indexHuge = minimalJs().replace('w[8]', 'w[99999999999999999999]');
    expect(extractSigCallSite(indexHuge)).toBeNull();
  });

  it('buildPlayerScript angka > int64 -> unknownPlayerHash', () => {
    const js = minimalJs().replace('Xm(46,8518,', 'Xm(46,99999999999999999999,');
    expectUnknownPlayerHash(() =>
      buildPlayerScript('/s/player/ad8d59ae/player_es6.vflset/en_US/base.js', js),
    );
  });

  it('template bersarang 100 level -> unknownPlayerHash', () => {
    const js = minimalJs({
      middleFn: `Xm=function(a,b,c){var s=${nestedTemplate(100)};return String[w[0]](c);}`,
    });
    expectUnknownPlayerHash(() =>
      buildPlayerScript('/s/player/ad8d59ae/player_es6.vflset/en_US/base.js', js),
    );
  });

  it('template bersarang 3 level tetap jalan (kontrol positif)', () => {
    const script = buildPlayerScript(
      '/s/player/ad8d59ae/player_es6.vflset/en_US/base.js',
      minimalJs({
        middleFn: `Xm=function(a,b,c){var s=${nestedTemplate(3)};return String[w[0]](c);}`,
      }),
    );
    expect(script.hash).toBe('ad8d59ae');
    expect(script.urlClassName).toBe('tf');
  });
});

describe('pengerasan Blue 4 (R4-I3): validasi identifier URL', () => {
  it('nama kelas berawalan digit (9x) ditolak saat ekstraksi', () => {
    expectUnknownPlayerHash(() =>
      buildPlayerScript(
        '/s/player/ad8d59ae/player_es6.vflset/en_US/base.js',
        minimalJs({ className: '9x' }),
      ),
    );
  });

  it('metode serialisasi berawalan digit (9f) ditolak saat ekstraksi', () => {
    expectUnknownPlayerHash(() =>
      buildPlayerScript(
        '/s/player/ad8d59ae/player_es6.vflset/en_US/base.js',
        minimalJs({
          classMethods:
            'set(a,b){}get(a){return null;}' +
            '9f(){this[w[1]]||(this[w[1]]=mB(19,1665,this));' +
            'return this[w[1]]}clone(){return this;}',
        }),
      ),
    );
  });
});

describe('base.js ASLI ketiga hash yang sedang live', () => {  const hashes = [
    {
      hash: 'fad7e4e9',
      sts: 20767,
      urlClass: 'tf',
      serialize: 'gf',
      setIndex: 8,
      middle: 'Ne',
    },
    {
      hash: 'ad8d59ae',
      sts: 20768,
      urlClass: 'bs',
      serialize: 'ff',
      setIndex: 14,
      middle: 'Xm',
    },
    {
      hash: 'b559f50c',
      sts: 20770,
      urlClass: 'JH',
      serialize: 'gf',
      setIndex: 6,
      middle: 'dy',
    },
  ];

  for (const expected of hashes) {
    it(`buildPlayerScript ${expected.hash}: hash, sts, rantai, kelas URL`, () => {
      const baseJs = loadFullBaseJs(expected.hash);
      if (baseJs === null) {
        console.warn(
          `base.js ${expected.hash} tidak ditemukan di arsip; tes dilewati`,
        );
        return;
      }
      const script = buildPlayerScript(
        `/s/player/${expected.hash}/player_es6.vflset/en_US/base.js`,
        baseJs,
      );
      expect(script.hash).toBe(expected.hash);
      expect(script.signatureTimestamp).toBe(expected.sts);
      expect(script.sigCallSite.middleName).toBe(expected.middle);
      expect(script.sigCallSite.setMethodTableIndex).toBe(expected.setIndex);
      expect(script.urlClassName).toBe(expected.urlClass);
      expect(script.urlSetMethod).toBe('set');
      expect(script.urlSerializeMethod).toBe(expected.serialize);
      // Prelude terukur di APK: ~12 KB, jauh di bawah cap 1 MB.
      expect(script.preludeCode.length).toBeGreaterThan(1000);
      expect(script.preludeCode.length).toBeLessThan(1024 * 1024);
      expect(script.preludeCode).toContain('var g = _yt_player;');
    });
  }

  it('prelude ad8d59ae (base.js penuh) memuat Vm', () => {
    const baseJs = loadFullBaseJs('ad8d59ae');
    if (baseJs === null) {
      console.warn('base.js ad8d59ae tidak ditemukan di arsip; tes dilewati');
      return;
    }
    const script = buildPlayerScript(
      '/s/player/ad8d59ae/player_es6.vflset/en_US/base.js',
      baseJs,
    );
    expect(script.preludeCode).toContain('Vm={');
    expect(script.sigCallSite.helperObjectName).toBe('String');
  });

  it('prelude b559f50c (base.js penuh) memakai tabel delimiter "{"', () => {
    const baseJs = loadFullBaseJs('b559f50c');
    if (baseJs === null) {
      console.warn('base.js b559f50c tidak ditemukan di arsip; tes dilewati');
      return;
    }
    const table = extractStringTable(baseJs);
    expect(table).not.toBeNull();
    expect(table).toMatch(/\.split\("\{"\);$/);
    const script = buildPlayerScript(
      '/s/player/b559f50c/player_es6.vflset/en_US/base.js',
      baseJs,
    );
    expect(script.preludeCode).toContain('mV={');
  });

  it('prelude ad8d59ae (base.js penuh) memakai tabel delimiter ";"', () => {
    const baseJs = loadFullBaseJs('ad8d59ae');
    if (baseJs === null) {
      console.warn('base.js ad8d59ae tidak ditemukan di arsip; tes dilewati');
      return;
    }
    const table = extractStringTable(baseJs);
    expect(table).not.toBeNull();
    expect(table).toMatch(/\.split\(";"\);$/);
  });
});

describe('varian player_ias b559f50c (generalisasi 22 Nov 2026)', () => {
  const kJsUrlIas = '/s/player/b559f50c/player_ias.vflset/en_US/base.js';
  const loadIas = () => loadFixture('base-js-ias-b559f50c.js');
  const kDriverArgs = {
    cipherUrl: 'https://rr1---sn-x.googlevideo.com/videoplayback?n=abc',
    cipheredS: 's-ciphered',
    sigParam: 'sig',
  };

  it('extractStringTableInfo membaca nama variabel tabel aa', () => {
    const info = extractStringTableInfo(loadIas());
    expect(info).not.toBeNull();
    expect(info!.varName).toBe('aa');
    expect(info!.statement).toMatch(/^aa="n\{\{call\{push\{/);
    expect(info!.statement).toMatch(/\.split\("\{"\);$/);
    // Kompatibel: extractStringTable tetap mengembalikan pernyataannya.
    expect(extractStringTable(loadIas())).toBe(info!.statement);
  });

  it('parseStringTable mengurai token aa (set/ff/prototype/url/call)', () => {
    const table = extractStringTable(loadIas());
    const tokens = parseStringTable(table!);
    expect(tokens).not.toBeNull();
    expect(tokens!.length).toBe(101);
    expect(tokens![28]).toBe('set');
    expect(tokens![71]).toBe('ff');
    expect(tokens![21]).toBe('prototype');
    expect(tokens![25]).toBe('url');
    expect(tokens![2]).toBe('call');
    expect(tokens![1]).toBe('');
  });

  it('extractSigCallSite: Hx / Go / cN + helper N_ + setIdx 28', () => {
    const site = extractSigCallSite(loadIas(), 'aa');
    expect(site).not.toBeNull();
    expect(site!.innerName).toBe('Hx');
    expect(site!.innerA).toBe(34);
    expect(site!.innerB).toBe(743);
    expect(site!.middleName).toBe('Go');
    expect(site!.middleA).toBe(4);
    expect(site!.middleB).toBe(5086);
    expect(site!.outerName).toBe('cN');
    expect(site!.outerA).toBe(1);
    expect(site!.outerB).toBe(8797);
    expect(site!.helperObjectName).toBe('N_');
    expect(site!.setMethodTableIndex).toBe(28);
  });

  it('solveExpression merangkai rantai ias dengan benar', () => {
    const site = extractSigCallSite(loadIas(), 'aa');
    expect(solveExpression(site!, '__s')).toBe(
      'cN(1,8797,Go(4,5086,Hx(34,743,__s)))',
    );
  });

  it('buildPlayerScript ias: hash, sts, rantai, kelas Rs, set, ff', () => {
    const script = buildPlayerScript(kJsUrlIas, loadIas());
    expect(script.hash).toBe('b559f50c');
    expect(script.signatureTimestamp).toBe(20770);
    expect(script.sigCallSite.innerName).toBe('Hx');
    expect(script.sigCallSite.middleName).toBe('Go');
    expect(script.sigCallSite.outerName).toBe('cN');
    expect(script.sigCallSite.helperObjectName).toBe('N_');
    expect(script.sigCallSite.setMethodTableIndex).toBe(28);
    expect(script.urlClassName).toBe('Rs');
    expect(script.urlSetMethod).toBe('set');
    expect(script.urlSerializeMethod).toBe('ff');
    // Prelude memuat tabel aa + rantai + helper N_.
    expect(script.preludeCode).toContain('aa="');
    expect(script.preludeCode).toContain('Go=function');
    expect(script.preludeCode).toContain('Hx=function');
    expect(script.preludeCode).toContain('cN=function');
    expect(script.preludeCode).toContain('N_={');
    expect(script.preludeCode).toContain('var g = _yt_player;');
    expect(script.preludeCode.length).toBeGreaterThan(1000);
    expect(script.preludeCode.length).toBeLessThan(1024 * 1024);
  });

  it('buildSolveDriver ias memakai rantai + kelas Rs + ff', () => {
    const script = buildPlayerScript(kJsUrlIas, loadIas());
    const driver = buildSolveDriver(script, kDriverArgs);
    expect(driver).toContain('cN(1,8797,Go(4,5086,Hx(34,743,__s)))');
    expect(driver).toContain('new _yt_player.Rs(');
    expect(driver).toContain('__u.set(');
    expect(driver).toContain('__u.ff();');
    expect(driver).not.toContain('_yt_player.JH');
    expect(driver).not.toContain('__u.gf();');
  });

  it('pola lama (tabel `w`) gagal di base.js ias', () => {
    // Bukti kontrol: pola lama mengasumsikan tabel `w` - tidak ada di
    // varian ias, jadi langkah 2 call site (m[aa[28]]...) tidak cocok.
    // (Kegagalan buildPlayerScript kode ASLI di file ini juga dibuktikan
    // Tim #16: kontrol /tmp/laras-exp/test-patched.js -> THROW.)
    expect(extractSigCallSite(loadIas())).toBeNull();
  });
});

describe('non-regresi es6: prelude+driver byte-identik pra-patch', () => {
  // Hash sha256 direkam dari kode ASLI sebelum patch (22 Nov 2026,
  // tes temporer __baseline.test.ts, 7/7): generalisasi tabel/ran-
  // tai/serialize TIDAK BOLEH mengubah satu byte pun keluaran es6.
  const kDriverArgs = {
    cipherUrl: 'https://rr1---sn-x.googlevideo.com/videoplayback?n=abc',
    cipheredS: 's-ciphered',
    sigParam: 'sig',
  };
  const sha = (s: string): string =>
    createHash('sha256').update(s, 'utf8').digest('hex');

  const kCases: Array<{
    label: string;
    fixture: string | null;
    archive: string | null;
    url: string;
    prelude: string;
    driver: string;
  }> = [
    {
      label: 'cuplikan fad7e4e9',
      fixture: 'base-js-snippet.js',
      archive: null,
      url: '/s/player/fad7e4e9/player_es6.vflset/en_US/base.js',
      prelude:
        'bff628a1595fdfaa4ed789574fd4b1afc15d31eb47227fe6d426658aa2826d21',
      driver:
        'b21a1b7dce13d576bc430ce733b4b63e632af2e6a31dfeb03558927989e18708',
    },
    {
      label: 'cuplikan ad8d59ae',
      fixture: 'base-js-snippet-ad8d59ae.js',
      archive: null,
      url: '/s/player/ad8d59ae/player_es6.vflset/en_US/base.js',
      prelude:
        'f4a3779707b1511b08623af39107a892fa8e3f1a7a7a043bc1235167daf56af3',
      driver:
        'cd29ea926e53a58f8007ec1c9a87627c4ce9d5bce272ef0cb2903b3c128c6790',
    },
    {
      label: 'cuplikan b559f50c',
      fixture: 'base-js-snippet-b559f50c.js',
      archive: null,
      url: '/s/player/b559f50c/player_es6.vflset/en_US/base.js',
      prelude:
        'e1ab4f1bab415435e26c3e1133687a074e3d2a9c0b6b5be71f009b6af6350a85',
      driver:
        '94c112806f2edce810c7c4baa895d99891dcb9c710c439aca1207845b23f6b91',
    },
    {
      label: 'base.js penuh fad7e4e9',
      fixture: null,
      url: '/s/player/fad7e4e9/player_es6.vflset/en_US/base.js',
      archive: 'fad7e4e9',
      prelude:
        'da1e13370d61ac9f87b43ba7deb8c6ab0c92ce051b6c938dc84b03e58adda3f5',
      driver:
        'b21a1b7dce13d576bc430ce733b4b63e632af2e6a31dfeb03558927989e18708',
    },
    {
      label: 'base.js penuh ad8d59ae',
      fixture: null,
      url: '/s/player/ad8d59ae/player_es6.vflset/en_US/base.js',
      archive: 'ad8d59ae',
      prelude:
        'f4a3779707b1511b08623af39107a892fa8e3f1a7a7a043bc1235167daf56af3',
      driver:
        'cd29ea926e53a58f8007ec1c9a87627c4ce9d5bce272ef0cb2903b3c128c6790',
    },
    {
      label: 'base.js penuh b559f50c es6',
      fixture: null,
      url: '/s/player/b559f50c/player_es6.vflset/en_US/base.js',
      archive: 'b559f50c',
      prelude:
        'e1ab4f1bab415435e26c3e1133687a074e3d2a9c0b6b5be71f009b6af6350a85',
      driver:
        '94c112806f2edce810c7c4baa895d99891dcb9c710c439aca1207845b23f6b91',
    },
  ] as const;

  for (const expected of kCases) {
    it(`${expected.label}: prelude+driver byte-identik`, () => {
      const baseJs =
        expected.fixture !== null
          ? loadFixture(expected.fixture)
          : expected.archive !== null
            ? loadFullBaseJs(expected.archive)
            : null;
      if (baseJs === null) {
        console.warn(
          `base.js ${expected.label} tidak ditemukan di arsip; tes dilewati`,
        );
        return;
      }
      const script = buildPlayerScript(expected.url, baseJs);
      expect(sha(script.preludeCode)).toBe(expected.prelude);
      expect(sha(buildSolveDriver(script, kDriverArgs))).toBe(
        expected.driver,
      );
    });
  }
});
