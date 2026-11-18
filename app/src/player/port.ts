/**
 * Port pemutar: SATU-SATUNYA lapisan yang menyentuh elemen audio.
 * Komponen UI tidak pernah memanggil elemen audio langsung
 * (arsitektur §3.3); semua akses lewat interface ini.
 *
 * Dua elemen audio dipakai dengan sengaja, bukan satu:
 * `createMediaElementSource` hanya bisa dipanggil sekali per
 * elemen, dan elemen yang sudah tersambung ke graph Web Audio
 * mengeluarkan NOL bila medianya lintas origin tanpa CORS (vonis
 * S5: googlevideo tidak mengirim header CORS). Satu elemen untuk
 * streaming (tidak pernah tersambung graph) dan satu elemen untuk
 * audio lokal (tersambung graph untuk EQ). Hanya elemen aktif yang
 * bersuara; yang tidak aktif dijeda dan sumbernya dikosongkan.
 */

export type AudioPortEvent =
  | 'loadedmetadata'
  | 'timeupdate'
  | 'play'
  | 'pause'
  | 'playing'
  | 'waiting'
  | 'ended'
  | 'error'
  | 'seeked';

export type AudioElementKind = 'stream' | 'local';

export interface AudioPortSnapshot {
  position: number;
  duration: number;
  bufferedEnd: number;
  paused: boolean;
  playbackRate: number;
  volume: number;
  /** Kode error MediaError (0 bila tidak ada error). */
  errorCode: number;
}

export interface AudioPlayerPort {
  /** Muat URL ke elemen sesuai jenisnya; elemen lain dimatikan. */
  load(url: string, kind: AudioElementKind): void;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  setRate(rate: number): void;
  /**
   * Atur volume elemen. Tanpa `kind`, kedua elemen diatur. Bila
   * graph tersambung, volume elemen lokal dijaga 1 (volume diatur
   * lewat GainNode), jadi service memakai kind 'stream' saja.
   */
  setVolume(volume: number, kind?: AudioElementKind): void;
  /** Elemen audio lokal (satu-satunya yang boleh masuk graph). */
  getLocalElement(): HTMLAudioElement;
  snapshot(): AudioPortSnapshot;
  on(event: AudioPortEvent, cb: () => void): () => void;
  dispose(): void;
}

const PORT_EVENTS: AudioPortEvent[] = [
  'loadedmetadata',
  'timeupdate',
  'play',
  'pause',
  'playing',
  'waiting',
  'ended',
  'error',
  'seeked',
];

/**
 * URL audio lokal yang sah (Red 1 I3): blob same-origin atau
 * http(s) same-origin (termasuk path relatif). URL host asing
 * ditolak — lagu lokal tidak pernah datang dari host lain, dan
 * URL-nya bisa berasal dari data tersimpan (antrean/library).
 */
export function isSafeLocalUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, window.location.href);
  } catch {
    return false;
  }
  if (parsed.protocol === 'blob:') {
    // blob:<origin>/<uuid>: origin pembuatnya wajib origin app.
    return parsed.origin === window.location.origin;
  }
  return (
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    parsed.origin === window.location.origin
  );
}

export class HtmlAudioPort implements AudioPlayerPort {
  private streamEl: HTMLAudioElement;
  private localEl: HTMLAudioElement;
  private active: AudioElementKind = 'stream';
  private listeners = new Map<AudioPortEvent, Set<() => void>>();
  private detach: Array<() => void> = [];

  constructor() {
    this.streamEl = new Audio();
    this.localEl = new Audio();
    for (const el of [this.streamEl, this.localEl]) {
      el.preload = 'auto';
    }
    const forward = (kind: AudioElementKind, event: AudioPortEvent) => {
      // Hanya event dari elemen aktif yang diteruskan.
      if (kind !== this.active) return;
      for (const cb of this.listeners.get(event) ?? []) cb();
    };
    for (const event of PORT_EVENTS) {
      const onStream = (): void => forward('stream', event);
      const onLocal = (): void => forward('local', event);
      this.streamEl.addEventListener(event, onStream);
      this.localEl.addEventListener(event, onLocal);
      this.detach.push(() => {
        this.streamEl.removeEventListener(event, onStream);
        this.localEl.removeEventListener(event, onLocal);
      });
    }
  }

  private activeEl(): HTMLAudioElement {
    return this.active === 'stream' ? this.streamEl : this.localEl;
  }

  load(url: string, kind: AudioElementKind): void {
    if (kind === 'local' && !isSafeLocalUrl(url)) {
      // URL tidak dicantumkan di pesan: isinya tidak tepercaya.
      throw new Error('URL audio lokal tidak diizinkan');
    }
    const idle = kind === 'stream' ? this.localEl : this.streamEl;
    idle.pause();
    idle.removeAttribute('src');
    idle.load();
    this.active = kind;
    const el = this.activeEl();
    el.src = url;
    el.load();
  }

  play(): Promise<void> {
    return this.activeEl().play();
  }

  pause(): void {
    this.activeEl().pause();
  }

  seek(seconds: number): void {
    const el = this.activeEl();
    if (!Number.isFinite(el.duration) || el.duration <= 0) return;
    el.currentTime = Math.min(Math.max(0, seconds), el.duration);
  }

  setRate(rate: number): void {
    this.streamEl.playbackRate = rate;
    this.localEl.playbackRate = rate;
  }

  setVolume(volume: number, kind?: AudioElementKind): void {
    const v = Math.min(1, Math.max(0, volume));
    if (kind === undefined || kind === 'stream') this.streamEl.volume = v;
    if (kind === undefined || kind === 'local') this.localEl.volume = v;
  }

  getLocalElement(): HTMLAudioElement {
    return this.localEl;
  }

  snapshot(): AudioPortSnapshot {
    const el = this.activeEl();
    let bufferedEnd = 0;
    try {
      const ranges = el.buffered;
      if (ranges.length > 0) bufferedEnd = ranges.end(ranges.length - 1);
    } catch {
      bufferedEnd = 0;
    }
    return {
      position: Number.isFinite(el.currentTime) ? el.currentTime : 0,
      duration: Number.isFinite(el.duration) ? el.duration : 0,
      bufferedEnd,
      paused: el.paused,
      playbackRate: el.playbackRate,
      volume: el.volume,
      errorCode: el.error ? el.error.code : 0,
    };
  }

  on(event: AudioPortEvent, cb: () => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  dispose(): void {
    for (const fn of this.detach) fn();
    this.detach = [];
    this.listeners.clear();
    for (const el of [this.streamEl, this.localEl]) {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
  }
}
