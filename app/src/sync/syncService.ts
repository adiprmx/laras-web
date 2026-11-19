/**
 * Orkestrasi sinkronisasi dua arah (P7).
 *
 * Satu putaran `syncNow`:
 *   1. Tarik perubahan dari server sejak `sync-last-pull`
 *      (inkremental), terapkan ke library lokal.
 *   2. Dorong seluruh state lokal (playlist, item, suka) +
 *      riwayat baru sejak penanda terakhir + tombstone hapus
 *      + pengaturan (bila berubah), dalam batch 100.
 *   3. Bila semua dorong berhasil: hapus tombstone yang sudah
 *      terkirim, simpan `sync-last-pull` = serverTime, bersihkan
 *      penanda hapus-riwayat, rapikan tombstone lama (>30 hari).
 *
 * Urutan tarik-dulu-dorong-belakangan adalah inti resolusi
 * konfliknya: perubahan server diterapkan ke lokal dulu,
 * sehingga dorong mengirim state gabungan (bukan menimpa
 * perubahan server dengan state lokal lama). Konflik nama
 * playlist yang diubah di dua perangkat sebelum sempat sinkron
 * dimenangkan versi server (yang sampai duluan) — batasan yang
 * didokumentasikan di laporan P7, sesuai protokol LWW S8.
 *
 * Login TIDAK PERNAH wajib: modul ini hanya dipanggil bila
 * pengguna sudah masuk (syncStore memeriksa status dulu).
 * Tanpa sesi, `syncNow` melempar SyncApiError 401 dan pemutar
 * tetap jalan normal.
 *
 * Riwayat didorong inkremental (hanya event dengan playedAt
 * lebih baru dari penanda) karena riwayat hanya bertambah dan
 * bisa mencapai 10.000 event — dorong penuh akan jadi ratusan
 * request. Playlist/suka didorong penuh (jumlahnya kecil).
 */
import { SYNC_HISTORY_CLEARED_KEY, getLibraryService, type LibraryService } from '../data/library';
import { getLyricsService } from '../lyrics/lyricsService';
import { normalizeEqSettings, type EqSettings } from '../player/equalizer';
import { getPlayerService } from '../player/service';
import { useEqualizerStore } from '../store/equalizer';
import { SYNC_PUSH_BATCH_SIZE } from './config';
import { getDeviceId } from './deviceId';
import {
  getSettingsMarkers,
  setSettingsAppliedAt,
} from './settingsMarkers';
import {
  fetchPull,
  fetchPush,
  type PullData,
  type PushBody,
} from './syncClient';

export const SYNC_LAST_PULL_KEY = 'sync-last-pull';
export const SYNC_HISTORY_PUSHED_KEY = 'sync-history-pushed-before';
const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SETTINGS_BYTES = 4096;

/** Isi settings_json yang disinkronkan (versi 1). */
export interface SyncSettingsPayload {
  version: 1;
  eq: EqSettings;
  lyricsEnabled: boolean;
}

export interface SyncDeps {
  pull: (since: number) => Promise<PullData>;
  push: (body: PushBody) => Promise<{ serverTime: number; applied: number }>;
}

export const defaultSyncDeps: SyncDeps = {
  pull: fetchPull,
  push: fetchPush,
};

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Terapkan satu respons tarik ke library lokal. */
export async function applyPull(
  library: LibraryService,
  pull: PullData,
): Promise<void> {
  // 1) Playlist dulu (item butuh playlist-nya ada).
  for (const p of pull.playlists) {
    const local = await library.playlistByClientId(p.clientId);
    if (p.deletedAt !== null) {
      if (local) await library.deletePlaylist(local.id, { quiet: true });
      continue;
    }
    if (local) {
      await library.applyRemotePlaylist(local.id, {
        name: p.nama,
        description: p.deskripsi,
        updatedAt: p.updatedAt,
      });
    } else {
      await library.createPlaylistFromRemote({
        clientId: p.clientId,
        name: p.nama,
        description: p.deskripsi,
        updatedAt: p.updatedAt,
      });
    }
  }
  // 2) Item playlist.
  for (const item of pull.playlistItems) {
    const playlist = await library.playlistByClientId(item.playlistClientId);
    if (!playlist) continue; // Playlist-nya belum ada / sudah dihapus.
    if (item.deletedAt !== null) {
      await library.removeSongFromPlaylist(playlist.id, item.videoId, {
        quiet: true,
      });
      continue;
    }
    await library.ensureRemoteSong(item.videoId, item.title, item.artist);
    await library.insertPlaylistItemAt(playlist.id, item.videoId, item.posisi);
  }
  // 3) Suka.
  for (const like of pull.likes) {
    if (like.deletedAt !== null) {
      try {
        await library.setLiked(like.videoId, false, { quiet: true });
      } catch {
        // Lagu tidak ada di lokal: tidak ada yang perlu dibatalkan.
      }
      continue;
    }
    await library.ensureRemoteSong(like.videoId, like.title, like.artist);
    await library.setLiked(like.videoId, true, { quiet: true });
  }
  // 4) Riwayat (dedup per lagu+waktu).
  for (const h of pull.history) {
    await library.ensureRemoteSong(h.videoId, h.title, h.artist);
    if (await library.hasPlayEvent(h.videoId, h.playedAt)) continue;
    await library.recordPlay({
      songId: h.videoId,
      timestamp: h.playedAt,
      playTimeMs: h.secondsPlayed * 1000,
    });
  }
  // 5) Pengaturan (hanya bila lebih baru dari yang sudah diterapkan).
  if (pull.settings) {
    const { appliedAt } = await getSettingsMarkers();
    if (pull.settings.updatedAt > appliedAt) {
      const payload = parseSettingsPayload(pull.settings.settingsJson);
      if (payload) {
        await getPlayerService().applySyncedEqSettings(payload.eq);
        const lyrics = await getLyricsService();
        await lyrics.setEnabled(payload.lyricsEnabled, { quiet: true });
        await setSettingsAppliedAt(pull.settings.updatedAt);
      }
    }
  }
}

export function parseSettingsPayload(
  raw: string,
): SyncSettingsPayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SyncSettingsPayload>;
    if (parsed.version !== 1) return null;
    if (typeof parsed.lyricsEnabled !== 'boolean') return null;
    return {
      version: 1,
      eq: normalizeEqSettings(parsed.eq),
      lyricsEnabled: parsed.lyricsEnabled,
    };
  } catch {
    return null;
  }
}

/** Kumpulkan seluruh state lokal menjadi body dorong. */
export async function collectPushBody(
  library: LibraryService,
  deviceId: string,
): Promise<PushBody> {
  const body: PushBody = { deviceId };

  // Playlist: beri clientId dulu bila belum punya.
  const playlists = await library.allPlaylists();
  const clientIds = new Map<number, string>();
  for (const p of playlists) {
    let clientId = p.clientId;
    if (!clientId) {
      clientId = `${deviceId}:${p.id}`;
      await library.setPlaylistClientId(p.id, clientId);
    }
    clientIds.set(p.id, clientId);
  }
  body.playlists = playlists.map((p) => ({
    clientId: clientIds.get(p.id) as string,
    nama: p.name,
    deskripsi: p.description,
  }));

  // Item playlist + metadata judul/artis untuk perangkat lain.
  const items: NonNullable<PushBody['playlistItems']> = [];
  for (const p of playlists) {
    const songs = await library.playlistSongsAll(p.id);
    if (songs.length === 0) continue;
    const views = await library.songsByIds(songs.map((s) => s.songId));
    const byId = new Map(views.map((v) => [v.song.id, v]));
    for (const s of songs) {
      const view = byId.get(s.songId);
      items.push({
        playlistClientId: clientIds.get(p.id) as string,
        videoId: s.songId,
        posisi: s.position,
        title: view?.song.title ?? null,
        artist: view?.artistNames.join(', ') ?? null,
      });
    }
  }
  body.playlistItems = items;

  // Suka.
  const liked = await library.allLikedSongs();
  body.likes = liked.map((v) => ({
    videoId: v.song.id,
    // likedAt tidak disimpan per lagu; dateModified dipakai
    // sebagai perkiraan terbaik (cukup untuk urutan tampilan).
    likedAt: v.song.dateModified,
    title: v.song.title,
    artist: v.artistNames.join(', ') || null,
  }));

  // Riwayat inkremental (hanya yang lebih baru dari penanda).
  const pushedBefore = Number(
    (await library.getMeta(SYNC_HISTORY_PUSHED_KEY)) ?? 0,
  );
  const events = await library.historyEvents(1000);
  const fresh = events.filter((e) => e.timestamp > pushedBefore);
  if (fresh.length > 0) {
    const views = await library.songsByIds([
      ...new Set(fresh.map((e) => e.songId)),
    ]);
    const byId = new Map(views.map((v) => [v.song.id, v]));
    body.history = fresh.map((e) => {
      const view = byId.get(e.songId);
      return {
        videoId: e.songId,
        playedAt: e.timestamp,
        secondsPlayed: Math.floor(e.playTimeMs / 1000),
        title: view?.song.title ?? null,
        artist: view?.artistNames.join(', ') ?? null,
      };
    });
  }

  // Tombstone hapus.
  const tombstones = await library.listTombstones();
  const deletedPlaylists: NonNullable<PushBody['deletedPlaylists']> = [];
  const deletedPlaylistItems: NonNullable<
    PushBody['deletedPlaylistItems']
  > = [];
  const deletedLikes: NonNullable<PushBody['deletedLikes']> = [];
  for (const t of tombstones) {
    if (t.kind === 'playlist') {
      deletedPlaylists.push({ clientId: t.ref });
    } else if (t.kind === 'playlist-item') {
      const sep = t.ref.lastIndexOf(':');
      if (sep > 0) {
        deletedPlaylistItems.push({
          playlistClientId: t.ref.slice(0, sep),
          videoId: t.ref.slice(sep + 1),
        });
      }
    } else if (t.kind === 'like') {
      deletedLikes.push({ videoId: t.ref });
    }
  }
  if (deletedPlaylists.length > 0) body.deletedPlaylists = deletedPlaylists;
  if (deletedPlaylistItems.length > 0) {
    body.deletedPlaylistItems = deletedPlaylistItems;
  }
  if (deletedLikes.length > 0) body.deletedLikes = deletedLikes;

  // Penanda hapus riwayat total.
  const clearedBefore = await library.getMeta(SYNC_HISTORY_CLEARED_KEY);
  if (clearedBefore) {
    body.historyClearedBefore = Number(clearedBefore);
  }

  // Pengaturan: hanya bila berubah sejak terakhir sinkron.
  const { localUpdatedAt, appliedAt } = await getSettingsMarkers();
  if (localUpdatedAt > appliedAt) {
    const payload: SyncSettingsPayload = {
      version: 1,
      eq: useEqualizerStore.getState().settings,
      lyricsEnabled: await (await getLyricsService()).isEnabled(),
    };
    const settingsJson = JSON.stringify(payload);
    if (new TextEncoder().encode(settingsJson).length <= MAX_SETTINGS_BYTES) {
      body.settings = { settingsJson };
    }
  }

  return body;
}

/** Satu putaran sinkronisasi penuh (tarik lalu dorong). */
export async function syncNow(
  deps: SyncDeps = defaultSyncDeps,
): Promise<{ serverTime: number; pushed: number }> {
  const library = await getLibraryService();
  const deviceId = await getDeviceId();

  // 1) Tarik.
  const since = Number((await library.getMeta(SYNC_LAST_PULL_KEY)) ?? 0);
  const pull = await deps.pull(Number.isFinite(since) ? since : 0);
  await applyPull(library, pull);

  // 2) Dorong (batch 100 per koleksi).
  const body = await collectPushBody(library, deviceId);
  const tombstones = await library.listTombstones();
  const chunks = {
    playlists: chunk(body.playlists ?? [], SYNC_PUSH_BATCH_SIZE),
    playlistItems: chunk(body.playlistItems ?? [], SYNC_PUSH_BATCH_SIZE),
    likes: chunk(body.likes ?? [], SYNC_PUSH_BATCH_SIZE),
    history: chunk(body.history ?? [], SYNC_PUSH_BATCH_SIZE),
    deletedPlaylists: chunk(
      body.deletedPlaylists ?? [],
      SYNC_PUSH_BATCH_SIZE,
    ),
    deletedPlaylistItems: chunk(
      body.deletedPlaylistItems ?? [],
      SYNC_PUSH_BATCH_SIZE,
    ),
    deletedLikes: chunk(body.deletedLikes ?? [], SYNC_PUSH_BATCH_SIZE),
  };
  const rounds = Math.max(
    1,
    ...Object.values(chunks).map((c) => c.length),
  );
  let serverTime = pull.serverTime;
  let pushed = 0;
  for (let i = 0; i < rounds; i++) {
    const roundBody: PushBody = {
      deviceId,
      playlists: chunks.playlists[i],
      playlistItems: chunks.playlistItems[i],
      likes: chunks.likes[i],
      history: chunks.history[i],
      deletedPlaylists: chunks.deletedPlaylists[i],
      deletedPlaylistItems: chunks.deletedPlaylistItems[i],
      deletedLikes: chunks.deletedLikes[i],
      // Settings + penanda hapus riwayat hanya di ronde pertama.
      ...(i === 0
        ? {
            settings: body.settings,
            historyClearedBefore: body.historyClearedBefore,
          }
        : {}),
    };
    const result = await deps.push(roundBody);
    serverTime = result.serverTime;
    pushed += result.applied;
  }

  // 3) Penanda sukses (hanya bila SEMUA dorong berhasil).
  await library.deleteTombstones(tombstones.map((t) => t.key));
  await library.setMeta(SYNC_LAST_PULL_KEY, String(serverTime));
  if (body.history) {
    const maxPlayedAt = Math.max(...body.history.map((h) => h.playedAt));
    await library.setMeta(SYNC_HISTORY_PUSHED_KEY, String(maxPlayedAt));
  }
  if (body.historyClearedBefore !== undefined) {
    await library.setMeta(SYNC_HISTORY_CLEARED_KEY, '');
  }
  if (body.settings) {
    await setSettingsAppliedAt(serverTime);
  }
  await library.pruneTombstones(Date.now() - TOMBSTONE_RETENTION_MS);

  return { serverTime, pushed };
}
