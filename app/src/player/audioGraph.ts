/**
 * Graph Web Audio (fondasi EQ, Must B2.1).
 *
 * Vonis S5: CORS TERTUTUP. googlevideo tidak mengirim header CORS
 * apa pun, sehingga `createMediaElementSource` pada stream
 * googlevideo mengeluarkan NOL (terbukti: analyser 0 mutlak selama
 * 5 detik padahal elemen memutar). Karena itu graph HANYA dipakai
 * untuk audio lokal/cache (blob dan same-origin, selalu lolos
 * CORS); streaming diputar langsung tanpa graph. Tanpa proxy audio
 * di v1 (keputusan arsitektur §3.4).
 *
 * Rantai P2: MediaElementSource -> GainNode (volume app) ->
 * destination. Simpul EQ 10 band (P7, Should) disisipkan di antara
 * source dan gain tanpa mengubah struktur ini.
 *
 * Rantai P7: MediaElementSource -> 10x BiquadFilter (peaking,
 * frekuensi ISO 31 Hz-16 kHz, Q 1) -> GainNode (volume app) ->
 * destination. Gain EQ disimpan di manager dan diterapkan ke
 * filter saat graph dibuat maupun saat diubah; stream TIDAK
 * PERNAH masuk graph (vonis S5), jadi EQ tidak pernah
 * membisukan streaming.
 *
 * Deteksi runtime (arsitektur §3.4): satu fetch CORS Range kecil
 * sebelum menyambung graph, hasil di-cache per host. Cache
 * di-seed dengan vonis S5: host googlevideo selalu tertutup,
 * sehingga stream tidak pernah membayar satu request probe pun.
 */
import type { AudioPath } from './types';
import {
  clampGain,
  EQ_FILTER_Q,
  EQ_FREQUENCIES,
  type EqSettings,
} from './equalizer';

const PROBE_TIMEOUT_MS = 5000;
const PROBE_RANGE_BYTES = 1023;

export class AudioGraphManager {
  private ctx: AudioContext | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private gain: GainNode | null = null;
  private eqFilters: BiquadFilterNode[] = [];
  private eqGains: number[] = new Array(EQ_FREQUENCIES.length).fill(0);
  private attachedElement: HTMLAudioElement | null = null;
  private volume = 1;
  private corsCache = new Map<string, boolean>();

  constructor() {
    // Seed vonis S5: googlevideo tidak mengirim header CORS.
    this.corsCache.set('googlevideo.com', false);
  }

  get isAttached(): boolean {
    return this.source !== null;
  }

  /** Apakah host ini diketahui tertutup CORS (seed S5 + hasil probe). */
  isHostCorsClosed(host: string): boolean {
    if (this.corsCache.has(host)) return this.corsCache.get(host) === false;
    if (host.endsWith('.googlevideo.com')) return true;
    return false;
  }

  /**
   * Tentukan jalur audio untuk satu URL. Blob, data, dan same-origin
   * selalu boleh masuk graph. Host lintas origin di-probe sekali
   * lalu hasilnya di-cache.
   */
  async decidePath(url: string): Promise<AudioPath> {
    if (url.startsWith('blob:') || url.startsWith('data:')) {
      return 'graph';
    }
    let parsed: URL;
    try {
      parsed = new URL(url, window.location.href);
    } catch {
      return 'direct';
    }
    if (parsed.origin === window.location.origin) return 'graph';
    if (this.isHostCorsClosed(parsed.hostname)) return 'direct';
    const cached = this.corsCache.get(parsed.hostname);
    if (cached !== undefined) return cached ? 'graph' : 'direct';
    const ok = await this.probeCors(parsed);
    this.corsCache.set(parsed.hostname, ok);
    return ok ? 'graph' : 'direct';
  }

  private async probeCors(url: URL): Promise<boolean> {
    try {
      const res = await fetch(url.toString(), {
        method: 'GET',
        mode: 'cors',
        headers: { Range: `bytes=0-${PROBE_RANGE_BYTES}` },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Sambungkan elemen audio lokal ke graph (sekali seumur elemen).
   * Setelah tersambung, volume diatur lewat GainNode dan volume
   * elemen dijaga 1.
   */
  attach(element: HTMLAudioElement): void {
    if (this.attachedElement === element && this.source) return;
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      // Rantai EQ: 10 filter peaking seri di depan gain. Source
      // disambung ke filter pertama saat attach (di bawah).
      let prev: AudioNode | null = null;
      for (let i = 0; i < EQ_FREQUENCIES.length; i += 1) {
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'peaking';
        filter.frequency.value = EQ_FREQUENCIES[i];
        filter.Q.value = EQ_FILTER_Q;
        filter.gain.value = this.eqGains[i] ?? 0;
        this.eqFilters.push(filter);
        if (prev) prev.connect(filter);
        prev = filter;
      }
      if (prev) prev.connect(this.gain);
      this.gain.connect(this.ctx.destination);
    }
    if (!this.source || this.attachedElement !== element) {
      this.source = this.ctx.createMediaElementSource(element);
      // Source masuk ke filter EQ pertama; bila filter belum ada
      // (graph lama), langsung ke gain.
      const head = this.eqFilters[0] ?? this.gain;
      if (head) this.source.connect(head);
      this.attachedElement = element;
    }
    element.volume = 1;
  }

  /** Terapkan gain EQ (dB) ke 10 filter; tersimpan walau graph belum dibuat. */
  setEqGains(gains: readonly number[]): void {
    this.eqGains = EQ_FREQUENCIES.map((_, i) =>
      clampGain(gains[i] ?? 0),
    );
    if (!this.ctx) return;
    for (let i = 0; i < this.eqFilters.length; i += 1) {
      this.eqFilters[i].gain.setTargetAtTime(
        this.eqGains[i],
        this.ctx.currentTime,
        0.01,
      );
    }
  }

  /** Terapkan satu pengaturan EQ lengkap (preset + gain). */
  applyEqSettings(settings: EqSettings): void {
    this.setEqGains(settings.gains);
  }

  get currentEqGains(): number[] {
    return [...this.eqGains];
  }

  /** Lanjutkan AudioContext yang tertunda (kebijakan autoplay). */
  async resume(): Promise<void> {
    if (this.ctx && this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        // Gagal resume bukan galat fatal: elemen tetap berbunyi
        // lewat jalur langsung bila graph tidak tersambung.
      }
    }
  }

  /** Volume app (0-1). Berlaku lewat GainNode bila graph tersambung. */
  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    if (this.gain && this.ctx) {
      this.gain.gain.setTargetAtTime(
        this.volume,
        this.ctx.currentTime,
        0.01,
      );
    }
  }

  get currentVolume(): number {
    return this.volume;
  }
}
