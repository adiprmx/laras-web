/**
 * Stub DOM minimal untuk menjalankan base.js YouTube di QuickJS
 * (port `js_stubs.dart` APK, isi byte-identik dengan versi Dart).
 *
 * QuickJS mentah tidak punya `window`, `document`, `navigator`, timer,
 * atau `console`. Base.js dievaluasi sebagai IIFE yang membaca global
 * tersebut saat inisialisasi. Stub ini memberi objek-objek kosong yang
 * menelan pemanggilan umum, cukup agar evaluasi berhasil dan kelas URL
 * internal bisa dipakai.
 *
 * Yang sengaja TIDAK distub: `fetch` (melempar bila dipanggil, solver
 * tidak boleh mengakses jaringan dari dalam JS), `URL`/`URLSearchParams`
 * (base.js memakai kelas URL-nya sendiri di jalur yang kita pakai).
 */

/** Skrip stub DOM. Dievaluasi SEBELUM sumber base.js di runtime yang sama. */
export const kJsDomStubs = `
(function () {
  function stubEl() {
    return {
      style: {}, dataset: {},
      classList: { add: function () {}, remove: function () {}, contains: function () { return false; }, toggle: function () {} },
      appendChild: function () {}, removeChild: function () {}, insertBefore: function () {},
      addEventListener: function () {}, removeEventListener: function () {},
      setAttribute: function () {}, getAttribute: function () { return null; }, removeAttribute: function () {},
      querySelector: function () { return null; }, querySelectorAll: function () { return []; },
      getElementsByTagName: function () { return []; }, getElementsByClassName: function () { return []; },
      getContext: function () { return null; },
      play: function () { return Promise.resolve(); }, pause: function () {},
      getBoundingClientRect: function () { return { left: 0, top: 0, width: 0, height: 0 }; },
      children: [], childNodes: [], parentNode: null, ownerDocument: null,
      textContent: '', innerHTML: '', src: '', href: '', width: 0, height: 0,
      focus: function () {}, blur: function () {}, click: function () {},
      cloneNode: function () { return stubEl(); }
    };
  }
  var docEl = stubEl();
  var bodyEl = stubEl();
  var headEl = stubEl();
  var documentStub = {
    createElement: function () { return stubEl(); },
    createElementNS: function () { return stubEl(); },
    createTextNode: function () { return {}; },
    createDocumentFragment: function () { return stubEl(); },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    getElementById: function () { return null; },
    getElementsByTagName: function () { return []; },
    documentElement: docEl, body: bodyEl, head: headEl,
    addEventListener: function () {}, removeEventListener: function () {},
    cookie: '', readyState: 'complete', title: '', hidden: false,
    visibilityState: 'visible',
    location: { href: 'https://www.youtube.com/' },
    referrer: '', domain: 'www.youtube.com'
  };
  var storageStub = {
    getItem: function () { return null; },
    setItem: function () {}, removeItem: function () {}, clear: function () {}
  };
  function NoopObserver() {}
  NoopObserver.prototype.observe = function () {};
  NoopObserver.prototype.disconnect = function () {};
  NoopObserver.prototype.unobserve = function () {};
  function XHRStub() {}
  XHRStub.prototype.open = function () {};
  XHRStub.prototype.send = function () {};
  XHRStub.prototype.setRequestHeader = function () {};
  XHRStub.prototype.addEventListener = function () {};
  XHRStub.prototype.abort = function () {};
  function TextEncoderStub() {}
  TextEncoderStub.prototype.encode = function (s) {
    var u = unescape(encodeURIComponent(s));
    var a = new Uint8Array(u.length);
    for (var i = 0; i < u.length; i++) a[i] = u.charCodeAt(i);
    return a;
  };
  function TextDecoderStub() {}
  TextDecoderStub.prototype.decode = function (b) {
    var s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return decodeURIComponent(escape(s));
  };
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function atobStub(s) {
    s = String(s).replace(/[^A-Za-z0-9+/=]/g, '');
    var out = '';
    var i = 0;
    while (i < s.length) {
      var e1 = B64.indexOf(s.charAt(i++));
      var e2 = B64.indexOf(s.charAt(i++));
      var e3 = B64.indexOf(s.charAt(i++));
      var e4 = B64.indexOf(s.charAt(i++));
      var n = (e1 << 18) | (e2 << 12) | ((e3 & 63) << 6) | (e4 & 63);
      out += String.fromCharCode((n >> 16) & 255);
      if (e3 !== 64) out += String.fromCharCode((n >> 8) & 255);
      if (e4 !== 64) out += String.fromCharCode(n & 255);
    }
    return out;
  }
  function btoaStub(s) {
    var out = '';
    var i = 0;
    while (i < s.length) {
      var c1 = s.charCodeAt(i++) & 255;
      var c2 = i < s.length ? s.charCodeAt(i++) & 255 : NaN;
      var c3 = i < s.length ? s.charCodeAt(i++) & 255 : NaN;
      var n = (c1 << 16) | ((isNaN(c2) ? 0 : c2) << 8) | (isNaN(c3) ? 0 : c3);
      out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63);
      out += isNaN(c2) ? '=' : B64.charAt((n >> 6) & 63);
      out += isNaN(c3) ? '=' : B64.charAt(n & 63);
    }
    return out;
  }

  globalThis.window = globalThis;
  globalThis.self = globalThis;
  globalThis.top = globalThis;
  globalThis.parent = globalThis;
  globalThis.document = documentStub;
  globalThis.navigator = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    platform: 'Win32', language: 'en-US', languages: ['en-US'], onLine: true,
    cookieEnabled: true, doNotTrack: null, maxTouchPoints: 0, mediaDevices: {}
  };
  globalThis.location = {
    href: 'https://www.youtube.com/', hostname: 'www.youtube.com',
    protocol: 'https:', pathname: '/', search: '', hash: ''
  };
  globalThis.history = {
    pushState: function () {}, replaceState: function () {}, state: null, length: 1
  };
  globalThis.screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1080 };
  globalThis.performance = {
    now: function () { return Date.now(); },
    getEntriesByType: function () { return []; },
    mark: function () {}, measure: function () {}, timing: {}
  };
  globalThis.requestAnimationFrame = function () { return 0; };
  globalThis.cancelAnimationFrame = function () {};
  globalThis.setTimeout = function () { return 0; };
  globalThis.clearTimeout = function () {};
  globalThis.setInterval = function () { return 0; };
  globalThis.clearInterval = function () {};
  globalThis.localStorage = storageStub;
  globalThis.sessionStorage = storageStub;
  globalThis.console = {
    log: function () {}, warn: function () {}, error: function () {},
    info: function () {}, debug: function () {}, trace: function () {}
  };
  globalThis.fetch = function () { throw new Error('fetch tidak tersedia di solver'); };
  globalThis.XMLHttpRequest = XHRStub;
  globalThis.MutationObserver = NoopObserver;
  globalThis.IntersectionObserver = NoopObserver;
  globalThis.ResizeObserver = NoopObserver;
  globalThis.CustomEvent = function (t, o) { this.type = t; };
  globalThis.Event = function (t) { this.type = t; };
  globalThis.Image = function () { return stubEl(); };
  globalThis.Audio = function () { return stubEl(); };
  globalThis.TextEncoder = TextEncoderStub;
  globalThis.TextDecoder = TextDecoderStub;
  globalThis.atob = atobStub;
  globalThis.btoa = btoaStub;
  globalThis.crypto = {
    getRandomValues: function (a) {
      for (var i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
      return a;
    },
    randomUUID: function () { return '00000000-0000-4000-8000-000000000000'; }
  };
})();
`;
