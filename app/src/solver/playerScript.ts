/**
 * Pengekstrak script player YouTube (base.js) - port TypeScript dari
 * `player_script.dart` APK (repo adiprmx/laras, RC v1.0.0).
 *
 * Tugas modul ini:
 * 1. Ekstrak `jsUrl` dari HTML youtube.com dan hash player dari pathnya.
 * 2. Ekstrak `signatureTimestamp` (sts) untuk request player.
 * 3. Ekstrak rantai signature dari call site di base.js: tiga nama fungsi
 *    + parameter numeriknya.
 * 4. Ekstrak info pemutar URL: nama kelas URL internal (`new g.XX(url)`),
 *    nama metode set (lewat tabel string), dan nama metode serialisasi
 *    (dari badan kelas). Ketiganya berputar per rilis player.
 * 5. Rakit prelude minimal solver: tabel string `w` + ketiga fungsi +
 *    dependensi TRANSITIF rantai (objek/fungsi helper yang dirujuk
 *    fungsi-fungsi itu, rekursif) + alias `g` ke `_yt_player`.
 *
 * Semua ekstraksi memakai pola perilaku (regex + pencocokan kurung) yang
 * ditulis dari pengamatan struktur base.js. Nama fungsi dan parameter
 * dibaca dari base.js saat berjalan, bukan di-hardcode.
 *
 * Bila pola tidak cocok (YouTube mengubah struktur player),
 * `buildPlayerScript` melempar `ExtractorException` penyebab
 * `unknownPlayerHash`; orkestrator memetakan itu ke status layanan.
 */
import { ExtractorException } from './errors';
import { kJsDomStubs } from './jsStubs';

/** Rantai tiga fungsi signature dari call site. */
export interface SigCallSite {
  /** Fungsi dalam: menerima `s` ciphered (mis. `uf(9,8472,s)`). */
  innerName: string;
  innerA: number;
  innerB: number;
  /** Fungsi tengah: transform signature utama (mis. `Ne(56,7789,...)`). */
  middleName: string;
  middleA: number;
  middleB: number;
  /** Fungsi luar: pengodean akhir (mis. `vf(2,6827,...)`). */
  outerName: string;
  outerA: number;
  outerB: number;
  /** Objek helper yang dipakai fungsi tengah (mis. `jB`). */
  helperObjectName: string;
  /**
   * Indeks tabel string untuk nama metode set URL di call site
   * (`f[w[N]](h, LUAR(...))` - `w[N]` adalah `'set'`). Indeksnya
   * berputar per rilis (8 di fad7e4e9, 14 di ad8d59ae, 6 di b559f50c),
   * jadi dibaca dari base.js, bukan di-hardcode.
   */
  setMethodTableIndex: number;
}

/** Ekspresi JS untuk menghitung signature dari variabel `cipheredVar`. */
export function solveExpression(
  site: SigCallSite,
  cipheredVar: string,
): string {
  return (
    `${site.outerName}(${site.outerA},${site.outerB},` +
    `${site.middleName}(${site.middleA},${site.middleB},` +
    `${site.innerName}(${site.innerA},${site.innerB},${cipheredVar})))`
  );
}

/** Script player yang sudah diekstrak dan siap dipakai solver. */
export interface PlayerScript {
  /** Path jsUrl, mis. `/s/player/fad7e4e9/player_es6.vflset/en_US/base.js`. */
  jsUrl: string;
  /** Hash player dari path (mis. `fad7e4e9`). */
  hash: string;
  /** `signatureTimestamp` (sts) dari base.js untuk request player. */
  signatureTimestamp: number;
  /**
   * Seluruh sumber base.js (dipakai solver QuickJS untuk transform `n`
   * lewat kelas URL internal player).
   */
  source: string;
  /** Rantai signature dari call site. */
  sigCallSite: SigCallSite;
  /**
   * Prelude minimal solver: tabel string + tiga fungsi signature +
   * dependensi transitif rantai + alias `g`. Dievaluasi di runtime
   * QuickJS yang sama dengan `source`.
   */
  preludeCode: string;
  /**
   * Nama kelas URL internal player (`_yt_player.<nama>`), dibaca dari
   * base.js di dekat call site. Berputar per rilis: `tf` (fad7e4e9),
   * `bs` (ad8d59ae), `JH` (b559f50c).
   */
  urlClassName: string;
  /** Nama metode set parameter URL (di ketiga hash yang diamati: `set`). */
  urlSetMethod: string;
  /**
   * Nama metode serialisasi URL (yang menjalankan transform `n` saat
   * membangun URL final): `gf` (fad7e4e9, b559f50c), `ff` (ad8d59ae).
   */
  urlSerializeMethod: string;
}

/** Info pemutar URL hasil `_extractUrlInfo`. */
export interface UrlInfo {
  className: string;
  setMethod: string;
  serializeMethod: string;
}

/** Parse bilangan bulat gaya Dart `int.tryParse`: null bila di luar int64. */
function tryParseInt64(digits: string): number | null {
  if (!/^\d+$/.test(digits)) return null;
  try {
    const value = BigInt(digits);
    if (value > 9223372036854775807n) return null;
    return Number(value);
  } catch {
    return null;
  }
}

/** Escape string agar aman dipakai sebagai literal di dalam RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Panjang string dalam byte UTF-8 (padanan `utf8.encode(s).length`). */
const utf8Encoder = new TextEncoder();
function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).length;
}

/**
 * Ekstrak `jsUrl` dari HTML youtube.com.
 * Mengembalikan path, mis. `/s/player/fad7e4e9/player_es6.vflset/en_US/base.js`.
 */
export function extractJsUrl(html: string): string | null {
  const match = /"jsUrl"\s*:\s*"([^"]+)"/.exec(html);
  return match ? match[1] : null;
}

/** Ekstrak hash player dari path jsUrl (`/s/player/<hash>/...`). */
export function extractPlayerHash(jsUrl: string): string | null {
  const match = /\/s\/player\/([A-Za-z0-9]+)\//.exec(jsUrl);
  return match ? match[1] : null;
}

/** Ekstrak `signatureTimestamp` dari sumber base.js. */
export function extractSignatureTimestamp(baseJs: string): number | null {
  const match = /signatureTimestamp\s*:\s*(\d+)/.exec(baseJs);
  if (!match) return null;
  return tryParseInt64(match[1]);
}

/**
 * Ekstrak tabel string dari base.js beserta nama variabelnya.
 *
 * Bentuk lama (s.d. fad7e4e9): `w='...'.split(";");` - kutip tunggal,
 * delimiter `;`. Bentuk baru (17 Nov 2026): `w="...".split("X");` -
 * kutip ganda, delimiter bervariasi per rilis (`;` di ad8d59ae, `{` di
 * b559f50c). Kedua bentuk diterima (lama dulu). Isi minimal 100 karakter
 * supaya tidak salah cocok dengan string pendek lain; `\"` di dalam isi
 * ditangani. Bila tidak ada yang cocok, kembalikan null.
 *
 * Nama variabel TIDAK diasumsikan `w`: varian build `player_ias`
 * (b559f50c, live 22 Nov 2026) memakai `aa`, dan seluruh pola turunan
 * (`aa[N]`) memakai nama yang dikembalikan di sini.
 */
export function extractStringTableInfo(baseJs: string): {
  statement: string;
  varName: string;
} | null {
  const legacy = /([A-Za-z_$][A-Za-z0-9_$]*)='[^']*'\.split\(";"\);/.exec(
    baseJs,
  );
  if (legacy) return { statement: legacy[0], varName: legacy[1] };
  const current =
    /([A-Za-z_$][A-Za-z0-9_$]*)="(?:\\.|[^"\\]){100,}"\.split\("[^"]{1,3}"\);/.exec(
      baseJs,
    );
  return current
    ? { statement: current[0], varName: current[1] }
    : null;
}

export function extractStringTable(baseJs: string): string | null {
  const info = extractStringTableInfo(baseJs);
  return info ? info.statement : null;
}

/**
 * Uraikan pernyataan tabel string (`w='...'.split(";");` atau
 * `w="...".split("X");`, keluaran `extractStringTable`) menjadi daftar
 * token. Escape JS (`\"`, `\\`, `\n`, `\uXXXX`) diurai sebelum split.
 * Null bila bentuk tidak dikenali.
 */
export function parseStringTable(
  tableStatement: string,
): string[] | null {
  // Nama variabel boleh apa saja (w/aa/...).
  const head = /^([A-Za-z_$][A-Za-z0-9_$]*)=/.exec(tableStatement);
  if (!head) return null;
  if (tableStatement.length < head[0].length + 1) return null;
  const quote = tableStatement[head[0].length];
  if (quote !== '"' && quote !== "'") return null;
  let content = '';
  let i = head[0].length + 1;
  while (i < tableStatement.length) {
    const ch = tableStatement[i];
    if (ch === '\\') {
      if (i + 1 >= tableStatement.length) return null;
      const next = tableStatement[i + 1];
      if (next === 'n') {
        content += '\n';
      } else if (next === 'r') {
        content += '\r';
      } else if (next === 't') {
        content += '\t';
      } else if (next === 'u' && i + 5 < tableStatement.length) {
        const codePoint = Number.parseInt(
          tableStatement.substring(i + 2, i + 6),
          16,
        );
        if (Number.isNaN(codePoint)) return null;
        content += String.fromCharCode(codePoint);
        i += 6;
        continue;
      } else {
        content += next;
      }
      i += 2;
    } else if (ch === quote) {
      break;
    } else {
      content += ch;
      i++;
    }
  }
  if (i >= tableStatement.length) return null;
  const rest = tableStatement.substring(i + 1);
  const m = /^\.split\((.)(.{1,3})\1\);?$/.exec(rest);
  if (!m) return null;
  return content.split(m[2]);
}

/**
 * Ekstrak definisi fungsi top-level `NAME=function(...)` dengan
 * pencocokan kurung kurawal (sadar string).
 */
export function extractFunction(
  baseJs: string,
  name: string,
): string | null {
  const pattern = new RegExp(
    `(?:^|[^A-Za-z0-9_$])${escapeRegExp(name)}=function\\(`,
  );
  const match = pattern.exec(baseJs);
  if (!match) return null;
  const start = match.index + match[0].indexOf(name);
  return extractBraced(baseJs, start);
}

/** Ekstrak literal objek top-level `NAME={...}` dengan pencocokan kurung. */
export function extractObjectLiteral(
  baseJs: string,
  name: string,
): string | null {
  const pattern = new RegExp(
    `(?:^|[^A-Za-z0-9_$])${escapeRegExp(name)}=\\{`,
  );
  const match = pattern.exec(baseJs);
  if (!match) return null;
  const start = match.index + match[0].indexOf(name);
  return extractBraced(baseJs, start);
}

/** Potong teks dari `start` sampai kurung kurawal penutup yang seimbang. */
function extractBraced(source: string, start: number): string | null {
  const braceStart = source.indexOf('{', start);
  if (braceStart < 0) return null;
  let depth = 0;
  let inString: string | null = null;
  let escaped = false;
  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString !== null) escaped = true;
      continue;
    }
    if (inString !== null) {
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return source.substring(start, i + 1);
    }
  }
  return null;
}

/** Pola rantai signature di call site: `TEMP = TENGAH(a,b,DALAM(a,b,X.s))`.
 *
 * Temp boleh dideklarasi lewat koma-deklarator
 * (`var m=l,n=h.sp,p=Go(...)` di player_ias) dan spasi sesudah koma
 * di argumen numerik ditoleransi. Grup tangkap 1-7 tidak berubah. */
const kSigChainPattern =
  /(?:var|let|const)\s+(?:[A-Za-z0-9_$]+\s*=\s*[^,;]+,\s*)*([A-Za-z0-9_$]+)\s*=\s*([A-Za-z0-9_$]+)\(\s*(\d+)\s*,\s*(\d+)\s*,\s*([A-Za-z0-9_$]+)\(\s*(\d+)\s*,\s*(\d+)\s*,\s*[A-Za-z0-9_$]+\.s\s*\)\s*\)/;

/**
 * Ekstrak rantai signature dari call site di base.js.
 *
 * Bentuk yang dicari (diamati di base.js fad7e4e9):
 * ```js
 * let l=Ne(56,7789,uf(9,8472,k.s));
 * f[w[8]](h,vf(2,6827,l))
 * ```
 * Mengembalikan null bila pola tidak cocok (player berubah).
 */
export function extractSigCallSite(
  baseJs: string,
  tableVar = 'w',
): SigCallSite | null {
  // Langkah 1: temp = TENGAH(a,b,DALAM(a,b,X.s))
  const chain = kSigChainPattern.exec(baseJs);
  if (!chain) return null;
  const tempVar = chain[1];
  const middleName = chain[2];
  // tryParse, bukan parse: grup \d+ tanpa batas bisa berisi angka
  // > int64 (base.js patologis). null di sini -> null -> unknownPlayerHash.
  const middleA = tryParseInt64(chain[3]);
  const middleB = tryParseInt64(chain[4]);
  const innerName = chain[5];
  const innerA = tryParseInt64(chain[6]);
  const innerB = tryParseInt64(chain[7]);
  if (
    middleA === null ||
    middleB === null ||
    innerA === null ||
    innerB === null
  ) {
    return null;
  }

  // Langkah 2: f[w[N]](h, AKHIR(a,b,tempVar)) di dekat call site (dalam
  // 500 karakter). Pembungkus `f[w[N]]` adalah pemanggilan metode set
  // URL - indeks N dibaca untuk `setMethodTableIndex`.
  const searchEnd = Math.min(chain.index + chain[0].length + 500, baseJs.length);
  const windowText = baseJs.substring(chain.index + chain[0].length, searchEnd);
  const outerPattern = new RegExp(
    `[A-Za-z0-9_$]+\\[${escapeRegExp(tableVar)}\\[(\\d+)\\]\\]\\([A-Za-z0-9_$]+,` +
      `([A-Za-z0-9_$]+)\\((\\d+),(\\d+),${escapeRegExp(tempVar)}\\)\\)`,
  );
  const outer = outerPattern.exec(windowText);
  if (!outer) return null;
  const setMethodTableIndex = tryParseInt64(outer[1]);
  const outerName = outer[2];
  const outerA = tryParseInt64(outer[3]);
  const outerB = tryParseInt64(outer[4]);
  if (setMethodTableIndex === null || outerA === null || outerB === null) {
    return null;
  }

  // Langkah 3: objek helper dari badan fungsi tengah - identifier yang
  // dipakai sebagai `IDENT[w[...]]` dan bukan parameter/lokal.
  const middleBody = extractFunction(baseJs, middleName);
  if (middleBody === null) return null;
  const helper = findHelperObject(middleBody, tableVar);
  if (helper === null) return null;

  return {
    innerName,
    innerA,
    innerB,
    middleName,
    middleA,
    middleB,
    outerName,
    outerA,
    outerB,
    helperObjectName: helper,
    setMethodTableIndex,
  };
}

/**
 * Cari objek helper di badan fungsi: identifier sebelum `[w[` yang bukan
 * parameter/lokal. Lokal dikumpulkan `collectJsLocals` (parameter, semua
 * deklarator `var`/`let`/`const` termasuk yang sesudah koma, parameter
 * `catch`/arrow).
 */
function findHelperObject(
  functionBody: string,
  tableVar = 'w',
): string | null {
  const blanked = blankJsCode(functionBody);
  const locals = collectJsLocals(blanked);
  const usePattern = new RegExp(
    '([A-Za-z0-9_$]+)\\[' + escapeRegExp(tableVar) + '\\[',
    'g',
  );
  for (const m of blanked.matchAll(usePattern)) {
    const name = m[1];
    if (!locals.has(name)) return name;
  }
  return null;
}

/**
 * Global bawaan JavaScript yang tidak punya literal di base.js.
 *
 * Bila helper call site adalah salah satunya (teramati: `String` di
 * base.js ad8d59ae, 17 Nov 2026 - cipher memakai `String[w[...]]`
 * seperti `String.fromCharCode`, dan metode string lewat parameter),
 * prelude tidak perlu memuat definisinya: QuickJS sudah
 * menyediakannya. Helper BUKAN builtin yang tidak ketemu literalnya
 * tetap gagal keras (kerusakan nyata).
 *
 * Set yang sama dipakai kolektor dependensi transitif
 * (`findJsReferences`): referensi ke nama-nama ini tidak dikejar ke
 * base.js. Baris kedua adalah global yang disediakan stub DOM
 * (`jsStubs.ts`) di runtime solver.
 */
export const kJsBuiltinGlobals: ReadonlySet<string> = new Set([
  'String',
  'Array',
  'Object',
  'Math',
  'Number',
  'Boolean',
  'JSON',
  'RegExp',
  'Date',
  'Map',
  'Set',
  'Symbol',
  'BigInt',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'decodeURIComponent',
  'encodeURIComponent',
  'decodeURI',
  'encodeURI',
  'eval',
  'escape',
  'unescape',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'AggregateError',
  'Promise',
  'Proxy',
  'Reflect',
  'WeakMap',
  'WeakSet',
  'WeakRef',
  'FinalizationRegistry',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'DataView',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'Intl',
  'globalThis',
  'undefined',
  'NaN',
  'Infinity',
  // Stub DOM (jsStubs.ts).
  'window',
  'self',
  'top',
  'parent',
  'document',
  'navigator',
  'location',
  'history',
  'screen',
  'performance',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'localStorage',
  'sessionStorage',
  'console',
  'fetch',
  'XMLHttpRequest',
  'MutationObserver',
  'IntersectionObserver',
  'ResizeObserver',
  'CustomEvent',
  'Event',
  'Image',
  'Audio',
  'TextEncoder',
  'TextDecoder',
  'atob',
  'btoa',
  'crypto',
]);

/** Kata kunci JS - bukan referensi variabel. */
const kJsKeywords: ReadonlySet<string> = new Set([
  'var',
  'let',
  'const',
  'function',
  'return',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'default',
  'break',
  'continue',
  'new',
  'typeof',
  'void',
  'delete',
  'in',
  'of',
  'instanceof',
  'this',
  'true',
  'false',
  'null',
  'try',
  'catch',
  'finally',
  'throw',
  'with',
  'yield',
  'await',
  'async',
  'class',
  'extends',
  'super',
  'get',
  'set',
  'static',
]);

const kJsIdentifierPattern = /[A-Za-z_$][A-Za-z0-9_$]*/;
const kJsIdentifierFullPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Kedalaman maksimum template literal `${...}` bersarang yang dipindai
 * pemindai JS kecil (`blankJsCode`/`skipJsBalanced` dan rekursi
 * mutualnya). Template di base.js nyata paling dalam 1-2 level;
 * 32 sangat longgar. Melebihi batas -> `ExtractorException`
 * unknownPlayerHash (bukan StackOverflowError) supaya kegagalan
 * masuk jalur terdegradasi loader/orkestrator seperti kegagalan
 * ekstraksi lain.
 */
export const kMaxTemplateDepth = 32;

/** Kegagalan kedalaman template - satu-satunya cara pemindai JS kecil gagal. */
function throwTemplateTooDeep(): never {
  throw new ExtractorException(
    'unknownPlayerHash',
    'template literal bersarang melebihi batas kedalaman',
  );
}

/** Indeks sesudah string berquote (`'`/`"`) yang dimulai di `start`. */
function skipJsQuoted(code: string, start: number): number {
  const quote = code[start];
  let i = start + 1;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '\\') {
      i += 2;
    } else if (ch === quote) {
      return i + 1;
    } else {
      i++;
    }
  }
  return code.length;
}

/** Indeks sesudah literal regex yang dimulai di `start` (`/` pembuka). */
function skipJsRegex(code: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '\\') {
      i += 2;
    } else if (ch === '[') {
      inClass = true;
      i++;
    } else if (ch === ']') {
      inClass = false;
      i++;
    } else if (ch === '/' && !inClass) {
      i++;
      break;
    } else if (ch === '\n') {
      break;
    } else {
      i++;
    }
  }
  while (i < code.length && 'dgimsuvy'.includes(code[i])) {
    i++;
  }
  return i;
}

/**
 * Indeks sesudah kurung `close` yang menutup `open` di `start`, sadar
 * string/template di dalamnya (dipakai untuk `${...}` dan daftar
 * parameter). `depth` adalah jumlah template literal yang membungkus
 * posisi pindai saat ini; template bersarang di dalamnya dihitung
 * lewat `skipJsTemplate` dan dibatasi `kMaxTemplateDepth`.
 */
function skipJsBalanced(
  code: string,
  start: number,
  open: string,
  close: string,
  depth = 0,
): number {
  let depthCounter = 0;
  let i = start;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'") {
      i = skipJsQuoted(code, i);
    } else if (ch === '`') {
      i = skipJsTemplate(code, i, depth + 1);
    } else if (ch === open) {
      depthCounter++;
      i++;
    } else if (ch === close) {
      depthCounter--;
      i++;
      if (depthCounter === 0) return i;
    } else {
      i++;
    }
  }
  return code.length;
}

/**
 * Indeks sesudah template literal yang dimulai di `start` (backtick).
 * `depth` adalah kedalaman template ini sendiri (1 = level terluar).
 */
function skipJsTemplate(code: string, start: number, depth = 1): number {
  if (depth > kMaxTemplateDepth) throwTemplateTooDeep();
  let i = start + 1;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '\\') {
      i += 2;
    } else if (ch === '`') {
      return i + 1;
    } else if (ch === '$' && i + 1 < code.length && code[i + 1] === '{') {
      i = skipJsBalanced(code, i + 1, '{', '}', depth);
    } else {
      i++;
    }
  }
  return code.length;
}

/**
 * Blank-kan isi string/komentar/regex dari `code` dengan spasi
 * (panjang dipertahankan supaya posisi tidak bergeser). Isi interpolasi
 * `${...}` template literal TETAP kode (diblank-kan rekursif) karena
 * bisa memuat referensi variabel.
 *
 * Tanpa blanking ini, pemindai referensi bisa salah mengira isi string
 * (`"Vm("` di pesan error) atau isi regex sebagai dependensi.
 */
function blankJsCode(code: string, depth = 0): string {
  const out: string[] = [];
  let i = 0;
  let prevSig = '';
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'") {
      const end = skipJsQuoted(code, i);
      out.push(' '.repeat(end - i));
      i = end;
      prevSig = 's';
    } else if (ch === '`') {
      i = blankJsTemplate(code, i, out, depth + 1);
      prevSig = 's';
    } else if (ch === '/' && i + 1 < code.length && code[i + 1] === '/') {
      let end = code.indexOf('\n', i);
      if (end < 0) end = code.length;
      out.push(' '.repeat(end - i));
      i = end;
    } else if (ch === '/' && i + 1 < code.length && code[i + 1] === '*') {
      let end = code.indexOf('*/', i + 2);
      end = end < 0 ? code.length : end + 2;
      out.push(' '.repeat(end - i));
      i = end;
    } else if (
      ch === '/' &&
      (prevSig === '' || '(,=:[!&|?{};'.includes(prevSig))
    ) {
      // Literal regex: '/' sesudah operator/pembuka (heuristik standar;
      // '/' sesudah nilai adalah pembagian).
      const end = skipJsRegex(code, i);
      out.push(' '.repeat(end - i));
      i = end;
      prevSig = 's';
    } else {
      out.push(ch);
      if (ch.trim() !== '') prevSig = ch;
      i++;
    }
  }
  return out.join('');
}

/**
 * Blank-kan satu template literal (mulai di backtick `start`) ke `out`:
 * bagian literal jadi spasi, isi `${...}` diblank-kan rekursif sebagai
 * kode. Mengembalikan indeks sesudah backtick penutup.
 */
function blankJsTemplate(
  code: string,
  start: number,
  out: string[],
  depth = 1,
): number {
  if (depth > kMaxTemplateDepth) throwTemplateTooDeep();
  out.push(' ');
  let i = start + 1;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '\\') {
      out.push('  ');
      i += 2;
    } else if (ch === '`') {
      out.push(' ');
      return i + 1;
    } else if (ch === '$' && i + 1 < code.length && code[i + 1] === '{') {
      const end = skipJsBalanced(code, i + 1, '{', '}', depth);
      out.push('  ');
      out.push(blankJsCode(code.substring(i + 2, end - 1), depth));
      out.push(' ');
      i = end;
    } else {
      out.push(' ');
      i++;
    }
  }
  return code.length;
}

function addJsParamList(locals: Set<string>, params: string): void {
  for (const part of params.split(',')) {
    const name = part.split('=')[0].trim();
    if (name !== '' && kJsIdentifierFullPattern.test(name)) {
      locals.add(name);
    }
  }
}

/**
 * Kumpulkan deklarator `var`/`let`/`const` dari `blanked` (kode yang
 * sudah diblank-kan string-nya) ke `locals`. Parser mini ini menangani
 * daftar koma (`var e=...,f=[]` - `f` adalah lokal) dan destructuring
 * (`var {a, b: c} = ...` - lokalnya `a` dan `c`, bukan kunci `b`),
 * yang dilewatkan regex sederhana.
 */
function collectJsDeclarators(blanked: string, locals: Set<string>): void {
  const decl = /(?:^|[^A-Za-z0-9_$])(?:var|let|const)\s+/g;
  for (const m of blanked.matchAll(decl)) {
    let i = m.index + m[0].length;
    while (i < blanked.length) {
      while (i < blanked.length && blanked[i].trim() === '') {
        i++;
      }
      if (i >= blanked.length) break;
      if (blanked[i] === '{' || blanked[i] === '[') {
        const open = blanked[i];
        const close = open === '{' ? '}' : ']';
        const end = skipJsBalanced(blanked, i, open, close);
        const inner = blanked.substring(i + 1, end - 1);
        for (const im of inner.matchAll(
          /[A-Za-z_$][A-Za-z0-9_$]*/g,
        )) {
          let k = im.index + im[0].length;
          while (k < inner.length && inner[k].trim() === '') {
            k++;
          }
          if (k >= inner.length || inner[k] !== ':') {
            locals.add(im[0]);
          }
        }
        i = end;
      } else {
        const sticky = new RegExp(kJsIdentifierPattern.source, 'y');
        sticky.lastIndex = i;
        const im = sticky.exec(blanked);
        if (!im) break;
        locals.add(im[0]);
        i = im.index + im[0].length;
      }
      while (i < blanked.length && blanked[i].trim() === '') {
        i++;
      }
      if (i < blanked.length && blanked[i] === '=') {
        // Lewati initializer sampai ',' / ';' / ')' di kedalaman 0.
        i++;
        let depth = 0;
        while (i < blanked.length) {
          const ch = blanked[i];
          if (ch === '(' || ch === '[' || ch === '{') {
            depth++;
          } else if (ch === ')' || ch === ']' || ch === '}') {
            if (depth === 0) break;
            depth--;
          } else if (depth === 0 && (ch === ',' || ch === ';')) {
            break;
          }
          i++;
        }
      }
      while (i < blanked.length && blanked[i].trim() === '') {
        i++;
      }
      if (i < blanked.length && blanked[i] === ',') {
        i++;
        continue;
      }
      break;
    }
  }
}

/**
 * Kumpulkan nama lokal dari badan definisi yang SUDAH diblank-kan
 * (`blankJsCode`): parameter fungsi/arrow, nama fungsi/class,
 * parameter `catch`, dan semua deklarator `var`/`let`/`const`.
 *
 * Batasan: nama di dalam parameter destructuring
 * (`function({a}){}`) tidak dikumpulkan - pola itu tidak muncul di
 * fungsi cipher ter-minifikasi yang diamati.
 */
function collectJsLocals(blanked: string): Set<string> {
  const locals = new Set<string>();
  for (const m of blanked.matchAll(
    /(?:^|[^A-Za-z0-9_$])function(?:\s+([A-Za-z_$][A-Za-z0-9_$]*))?\s*\(([^)]*)\)/g,
  )) {
    if (m[1] !== undefined) locals.add(m[1]);
    addJsParamList(locals, m[2]);
  }
  for (const m of blanked.matchAll(/\(([^)]*)\)\s*=>/g)) {
    addJsParamList(locals, m[1]);
  }
  for (const m of blanked.matchAll(
    /(?:^|[^A-Za-z0-9_$])([A-Za-z_$][A-Za-z0-9_$]*)\s*=>/g,
  )) {
    locals.add(m[1]);
  }
  for (const m of blanked.matchAll(
    /(?:^|[^A-Za-z0-9_$])catch\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)/g,
  )) {
    locals.add(m[1]);
  }
  for (const m of blanked.matchAll(
    /(?:^|[^A-Za-z0-9_$])class\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
  )) {
    locals.add(m[1]);
  }
  collectJsDeclarators(blanked, locals);
  return locals;
}

/**
 * Referensi global dari satu definisi (fungsi/objek): identifier yang
 * dipakai sebagai `IDENT[w[...]]` (objek helper) atau `IDENT(...)`
 * (panggilan fungsi, termasuk `?.(`), BUKAN properti (`.IDENT`),
 * bukan lokal/parameter, bukan keyword, bukan global bawaan, dan bukan
 * tabel `w`.
 *
 * Definisi metode shorthand (`m(a){...}`) dikecualikan: `IDENT(...)`
 * yang langsung diikuti `{` adalah definisi, bukan panggilan (di kode
 * ter-minifikasi, panggilan selalu diikuti `;`/operator).
 * Referensi telanjang (`return Foo`) sengaja TIDAK dikejar: di badan
 * fungsi cipher, identifier telanjang adalah decoy cabang mati
 * (`Baa..Taa` di `ld` ad8d59ae) yang definisinya tidak pernah dipakai
 * jalur hidup - mengejarnya menggelembungkan prelude dari 20 menjadi
 * 95 definisi (terukur di ad8d59ae) tanpa manfaat.
 */
function findJsReferences(
  definition: string,
  tableVar = 'w',
): Set<string> {
  const blanked = blankJsCode(definition);
  const locals = collectJsLocals(blanked);
  const refs = new Set<string>();
  const usePattern = new RegExp(
    '([A-Za-z_$][A-Za-z0-9_$]*)\\s*(?:\\[' +
      escapeRegExp(tableVar) +
      '\\[|\\?\\.\\[' +
      escapeRegExp(tableVar) +
      '\\[|\\(|\\?\\.\\()',
    'g',
  );
  for (const m of blanked.matchAll(usePattern)) {
    const name = m[1];
    if (
      kJsKeywords.has(name) ||
      kJsBuiltinGlobals.has(name) ||
      locals.has(name) ||
      name === tableVar
    ) {
      continue;
    }
    if (m.index > 0 && blanked[m.index - 1] === '.') continue;
    const tail = m[0];
    if (tail.endsWith('(')) {
      const paren = m.index + m[0].length - 1;
      const end = skipJsBalanced(blanked, paren, '(', ')');
      let k = end;
      while (k < blanked.length && blanked[k].trim() === '') {
        k++;
      }
      if (k < blanked.length && blanked[k] === '{') continue;
    }
    refs.add(name);
  }
  return refs;
}

/**
 * Definisi top-level `NAME`: fungsi `NAME=function...` dulu, lalu
 * literal objek `NAME={...}`. Null bila tidak ada keduanya.
 */
function extractDefinition(baseJs: string, name: string): string | null {
  return extractFunction(baseJs, name) ?? extractObjectLiteral(baseJs, name);
}

/**
 * Batas jumlah definisi prelude (pengaman terhadap base.js patologis
 * yang rantainya meledak; terukur: ad8d59ae 20, b559f50c 13,
 * fad7e4e9 4). BFS menjamin dependensi terdekat dari rantai
 * didahulukan, jadi pemotongan hanya membuang cincin terjauh.
 *
 * Keputusan sadar (dipin tes regresi R4-I1): cap JUMLAH ini MEMOTONG,
 * bukan gagal - rantai nyata yang berekor panjang tetap jalan dengan
 * dependensi terdekatnya. Yang GAGAL keras adalah cap BYTE
 * (`kMaxPreludeBytes`): prelude raksasa menandakan base.js patologis
 * dan definisi yang terpotong akan gagal ReferenceError saat solve,
 * lebih buruk daripada gagal jelas di ekstraksi.
 */
export const kMaxPreludeDependencies = 64;

/**
 * Batas total byte prelude (pernyataan tabel + alias `g` + semua
 * definisi), diukur byte UTF-8. Terukur di tiga hash nyata: ~12 KB;
 * 1 MB sangat longgar. Melebihi batas -> `ExtractorException`
 * unknownPlayerHash, ditegakkan SELAMA pengumpulan (bukan sesudah
 * rakit) supaya 64 definisi raksasa yang tumpang tindih tidak sempat
 * menumpuk ratusan MB di memori.
 */
export const kMaxPreludeBytes = 1024 * 1024;

/**
 * Kumpulkan dependensi TRANSITIF rantai signature (BFS dari `seeds`):
 * untuk tiap definisi, cari referensi globalnya (`findJsReferences`)
 * lalu ambil definisinya dari `baseJs`. Nama tanpa definisi di base.js
 * (decoy cabang mati seperti `Taa`, parameter IIFE `g`) dilewati -
 * tidak ada yang bisa dimuat untuknya.
 *
 * `initialBytes` adalah byte prelude yang sudah terpakai sebelum
 * definisi (pernyataan tabel; alias `g` + pemisah menambah < 200 byte
 * dan diabaikan terhadap cap 1 MB). Bila total byte melewati
 * `kMaxPreludeBytes`, lempar `ExtractorException` unknownPlayerHash.
 *
 * Mengembalikan definisi dalam urutan penemuan BFS (seed dulu).
 */
function collectTransitiveDependencies(
  baseJs: string,
  seeds: Map<string, string>,
  initialBytes = 0,
  tableVar = 'w',
): Map<string, string> {
  const collected = new Map<string, string>(seeds);
  let totalBytes = initialBytes;
  const addBytes = (definition: string): void => {
    totalBytes += utf8ByteLength(definition);
    if (totalBytes > kMaxPreludeBytes) {
      throw new ExtractorException(
        'unknownPlayerHash',
        'prelude melebihi batas byte',
      );
    }
  };

  for (const definition of seeds.values()) {
    addBytes(definition);
  }
  const queue = [...seeds.keys()];
  let head = 0;
  while (head < queue.length && collected.size < kMaxPreludeDependencies) {
    const definition = collected.get(queue[head++]) as string;
    for (const ref of findJsReferences(definition, tableVar)) {
      if (collected.has(ref)) continue;
      const refDef = extractDefinition(baseJs, ref);
      if (refDef === null) continue;
      addBytes(refDef);
      collected.set(ref, refDef);
      queue.push(ref);
      if (collected.size >= kMaxPreludeDependencies) break;
    }
  }
  return collected;
}

/**
 * Ekstrak definisi kelas top-level `g.NAME=class{...}` dengan
 * pencocokan kurung kurawal (sadar string).
 */
export function extractClassDefinition(
  baseJs: string,
  name: string,
): string | null {
  const pattern = new RegExp(
    `(?:^|[^A-Za-z0-9_$])g\\.${escapeRegExp(name)}=class`,
  );
  const match = pattern.exec(baseJs);
  if (!match) return null;
  const start = match.index + match[0].indexOf('g.');
  return extractBraced(baseJs, start);
}

/**
 * Nama metode serialisasi URL dari badan kelas URL.
 *
 * Pola utama (diamati di bs/JH/tf): metode tanpa parameter yang
 * menghitung sekali lalu mengembalikan string cache -
 * `ff(){this[w[1]]||(this[w[1]]=mB(19,1665,this));return this[w[1]]}`.
 * Cadangan: satu-satunya metode di luar {constructor, set, get, clone,
 * ...} - nama-nama yang sudah pasti bukan serializer.
 */
function findUrlSerializeMethod(
  classBody: string,
  tableVar = 'w',
): string | null {
  const tv = escapeRegExp(tableVar);
  const cached = new RegExp(
    `([A-Za-z0-9_$]+)\\(\\)\\{this\\[${tv}\\[(\\d+)\\]\\]\\|\\|\\(this\\[${tv}\\[\\2\\]\\]=[A-Za-z0-9_$]+\\(\\d+,\\d+,this\\)\\);return this\\[${tv}\\[\\2\\]\\]\\}`,
  ).exec(classBody);
  if (cached) return cached[1];
  const notSerializer = new Set([
    'constructor',
    'set',
    'get',
    'clone',
    'toString',
    'has',
    'delete',
    'keys',
    'values',
    'entries',
    'forEach',
    'clear',
  ]);
  const blanked = blankJsCode(classBody);
  const candidates = new Set<string>();
  const methodPattern = /([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  for (const m of blanked.matchAll(methodPattern)) {
    const name = m[1];
    if (kJsKeywords.has(name) || notSerializer.has(name)) {
      continue;
    }
    if (m.index > 0 && blanked[m.index - 1] === '.') continue;
    // Definisi metode: `NAMA(...)` langsung diikuti `{` (panggilan
    // diikuti `;`/operator/).
    const paren = m.index + m[0].length - 1;
    const end = skipJsBalanced(blanked, paren, '(', ')');
    let k = end;
    while (k < blanked.length && blanked[k].trim() === '') {
      k++;
    }
    if (k < blanked.length && blanked[k] === '{') candidates.add(name);
  }
  if (candidates.size === 1) return [...candidates][0];
  return null;
}

/**
 * Ekstrak info pemutar URL dari base.js: nama kelas URL internal,
 * nama metode set, dan nama metode serialisasi. Null bila ada bagian
 * yang tidak ketemu (player berubah).
 *
 * - Kelas: `new g.XX(var.url)` TERAKHIR sebelum call site rantai
 *   (di fungsi yang sama dengan pemanggilan cipher - jarak 42 karakter
 *   di ad8d59ae dan b559f50c).
 * - Metode set: `w[N]` dari `SigCallSite.setMethodTableIndex`, diurai
 *   lewat `table` (harus identifier JS yang valid).
 * - Serialisasi: `findUrlSerializeMethod` pada badan kelas.
 */
function extractUrlInfo(
  baseJs: string,
  callSite: SigCallSite,
  table: string[],
  tableVar = 'w',
): UrlInfo | null {
  const setIndex = callSite.setMethodTableIndex;
  if (setIndex < 0 || setIndex >= table.length) return null;
  const setMethod = table[setIndex];
  if (!kJsIdentifierFullPattern.test(setMethod)) {
    return null;
  }
  const chain = kSigChainPattern.exec(baseJs);
  if (!chain) return null;
  const urlClassPattern = /new g\.([A-Za-z0-9_$]+)\([A-Za-z0-9_$]+\.url/g;
  let className: string | null = null;
  for (const m of baseJs
    .substring(0, chain.index)
    .matchAll(urlClassPattern)) {
    className = m[1];
  }
  if (className === null) return null;
  // Validasi identifier ketat yang sama seperti setMethod: regex
  // `[A-Za-z0-9_$]+` membolehkan awalan digit (`9x`) yang bukan
  // identifier JS valid - tolak di ekstraksi (unknownPlayerHash),
  // bukan baru gagal SyntaxError saat solve.
  if (!kJsIdentifierFullPattern.test(className)) {
    return null;
  }
  const classBody = extractClassDefinition(baseJs, className);
  let serializeMethod: string | null = null;
  if (classBody !== null) {
    serializeMethod = findUrlSerializeMethod(classBody, tableVar);
  } else {
    // Fallback player_ias: tidak ada `g.X=class` sama sekali di build
    // ini - metode dilekatkan ke prototipe:
    // `g.Rs[aa[21]][aa[71]]=function(){this[aa[25]]||(...);...}`.
    // Nama metode dibaca dari tabel (indeks grup 2).
    const tv = escapeRegExp(tableVar);
    const proto = new RegExp(
      'g\\.' +
        escapeRegExp(className) +
        '\\[' +
        tv +
        '\\[(\\d+)\\]\\]\\[' +
        tv +
        '\\[(\\d+)\\]\\]=function\\(\\)\\{this\\[' +
        tv +
        '\\[(\\d+)\\]\\]\\|\\|\\(this\\[' +
        tv +
        '\\[\\3\\]\\]=[A-Za-z0-9_$]+\\(\\d+,\\d+,this\\)\\);return this\\[' +
        tv +
        '\\[\\3\\]\\]\\}',
    ).exec(baseJs);
    if (proto) {
      const methodIndex = tryParseInt64(proto[2]);
      if (
        methodIndex !== null &&
        methodIndex >= 0 &&
        methodIndex < table.length
      ) {
        serializeMethod = table[methodIndex];
      }
    }
  }
  if (serializeMethod === null) return null;
  if (!kJsIdentifierFullPattern.test(serializeMethod)) {
    return null;
  }
  return {
    className,
    setMethod,
    serializeMethod,
  };
}

/**
 * Rakit `PlayerScript` dari sumber base.js + jsUrl.
 *
 * Melempar `ExtractorException` penyebab unknownPlayerHash bila ada
 * ekstraksi yang gagal.
 */
export function buildPlayerScript(
  jsUrl: string,
  baseJs: string,
): PlayerScript {
  const hash = extractPlayerHash(jsUrl);
  const sts = extractSignatureTimestamp(baseJs);
  const tableInfo = extractStringTableInfo(baseJs);
  const table = tableInfo === null ? null : tableInfo.statement;
  const tableVar = tableInfo === null ? 'w' : tableInfo.varName;
  const callSite = extractSigCallSite(baseJs, tableVar);
  const tableTokens = table === null ? null : parseStringTable(table);
  if (
    hash === null ||
    sts === null ||
    callSite === null ||
    table === null ||
    tableTokens === null
  ) {
    throw new ExtractorException(
      'unknownPlayerHash',
      'ekstraksi base.js gagal ' +
        `(hash: ${hash !== null}, sts: ${sts !== null}, ` +
        `callSite: ${callSite !== null}, table: ${table !== null}, ` +
        `tableTokens: ${tableTokens !== null})`,
    );
  }
  const innerFn = extractFunction(baseJs, callSite.innerName);
  const middleFn = extractFunction(baseJs, callSite.middleName);
  const outerFn = extractFunction(baseJs, callSite.outerName);
  const helperObj = extractObjectLiteral(baseJs, callSite.helperObjectName);
  if (innerFn === null || middleFn === null || outerFn === null) {
    throw new ExtractorException(
      'unknownPlayerHash',
      'definisi fungsi signature tidak ketemu di base.js',
    );
  }
  if (helperObj === null && !kJsBuiltinGlobals.has(callSite.helperObjectName)) {
    throw new ExtractorException(
      'unknownPlayerHash',
      `literal objek helper ${callSite.helperObjectName} ` +
        'tidak ketemu di base.js',
    );
  }
  const urlInfo = extractUrlInfo(baseJs, callSite, tableTokens, tableVar);
  if (urlInfo === null) {
    throw new ExtractorException(
      'unknownPlayerHash',
      'info kelas URL (g.XX/set/serialisasi) tidak ketemu di base.js',
    );
  }
  // Dependensi TRANSITIF: prelude lama hanya memuat 3 fungsi + 1 objek
  // helper, sehingga rantai cipher yang memakai helper lain (teramati:
  // `Vm` di ad8d59ae, 17 Nov 2026 - `Xm` memanggil `Vm[w[...]]` tapi
  // prelude hanya memuat helper pertama yang ketemu, `String`) gagal
  // `ReferenceError` saat solve. Kumpulkan semua definisi yang dirujuk
  // rantai, rekursif - bukan hanya helper pertama.
  const seeds = new Map<string, string>([
    [callSite.innerName, innerFn],
    [callSite.middleName, middleFn],
    [callSite.outerName, outerFn],
  ]);
  if (helperObj !== null) seeds.set(callSite.helperObjectName, helperObj);
  const definitions = collectTransitiveDependencies(
    baseJs,
    seeds,
    // Cap byte mengukur TOTAL prelude: pernyataan tabel dihitung
    // sebagai byte awal (alias `g` + pemisah < 200 byte, diabaikan).
    utf8ByteLength(table),
    tableVar,
  );
  const preludeParts: string[] = [table];
  // Alias parameter IIFE: base.js berjalan sebagai
  // `(function(g){...})(_yt_player)` - dependensi rantai memakai
  // `g.jr`/`g.Um`/`g.O` (properti `_yt_player` yang sudah terisi saat
  // sumber dievaluasi, sebelum prelude). Tanpa alias ini definisi
  // tersebut gagal `ReferenceError: g is not defined` bila cabangnya
  // hidup di hash mendatang. Dilewati bila `g` ternyata nama definisi
  // rantai (tabrakan - definisi asli menang).
  if (!definitions.has('g')) preludeParts.push('var g = _yt_player;');
  for (const definition of definitions.values()) {
    preludeParts.push(`${definition};`);
  }
  const prelude = preludeParts.join('\n');
  return {
    jsUrl,
    hash,
    signatureTimestamp: sts,
    source: baseJs,
    sigCallSite: callSite,
    preludeCode: prelude,
    urlClassName: urlInfo.className,
    urlSetMethod: urlInfo.setMethod,
    urlSerializeMethod: urlInfo.serializeMethod,
  };
}

/**
 * Skrip driver solver: hitung signature dari cipher lalu bangun URL final
 * lewat kelas URL internal player (`_yt_player.<urlClassName>`), yang
 * sekaligus menjalankan transform `n` saat serialisasi.
 *
 * Nama kelas/metode dibaca dari base.js per hash (`PlayerScript.urlClassName`
 * dkk.) - ketiganya identifier JS valid hasil pencocokan pola ketat,
 * jadi aman diinterpolasi ke skrip. `cipherUrl`, `cipheredS`, dan
 * `sigParam` disisipkan sebagai literal JSON agar aman dari injeksi.
 */
export function buildSolveDriver(
  script: PlayerScript,
  options: { cipherUrl: string; cipheredS: string; sigParam: string },
): string {
  const sigExpr = solveExpression(script.sigCallSite, '__s');
  return (
    `var __s = ${JSON.stringify(options.cipheredS)};\n` +
    `var __sig = ${sigExpr};\n` +
    `var __u = new _yt_player.${script.urlClassName}(${JSON.stringify(options.cipherUrl)}, true);\n` +
    `__u.${script.urlSetMethod}(${JSON.stringify(options.sigParam)}, decodeURIComponent(__sig));\n` +
    `__u.${script.urlSerializeMethod}();\n`
  );
}

/**
 * Seluruh skrip yang dievaluasi sekali saat inisialisasi solver:
 * stub DOM + sumber base.js + prelude signature.
 */
export function buildSolverInitScript(script: PlayerScript): string {
  return `${kJsDomStubs}\n${script.source}\n${script.preludeCode}\n`;
}
