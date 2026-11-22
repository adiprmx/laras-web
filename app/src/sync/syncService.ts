/**
 * Orkestrasi sinkronisasi dua arah (P7).
 *
 * Satu putaran `syncNow`:
 *   1. Tarik perubahan dari server sejak `sync-last-pull`
 *      (inkremental, berhalaman), terapkan ke library lokal.
 *   2. Dorong DELTA lokal (P-PushDelta): hanya playlist/item/suka
 *      yang berubah sejak dorong terakhir (penanda dirty eksplisit
 *      di app_meta) + riwayat baru sejak penanda terakhir +
 *      tombstone hapus + pengaturan (bila berubah), dalam batch
 *      100. Dorong pertama sesudah masuk adalah dorong PENUH
 *      (baseline) lalu flag init diset.
 *   3. Bila semua dorong berhasil: hapus tombstone yang sudah
 *      terkirim, bersihkan penanda dirty yang terdorong (hanya
 *      yang versinya masih sama dengan snapshot), simpan
 *      `sync-last-pull` = watermark, bersihkan penanda
 *      hapus-riwayat, rapikan tombstone lama (>30 hari).
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
 * request. Playlist/suka/item didorong delta (penanda dirty)
 * sejak P-PushDelta, dengan dorong penuh sekali sebagai baseline.
 */
import {
  SYNC_HISTORY_CLEARED_KEY,
  getLibraryService,
  type LibraryService,
  type SyncDirtyEntry,
} from '../data/library';
import { getLyricsService } from '../lyrics/lyricsService';
import { normalizeEqSettings, type EqSettings } from '../player/equalizer';
import { getPlayerService } from '../player/service';
import { useEqualizerStore } from '../store/equalizer';
import { SYNC_PUSH_BATCH_SIZE } from './config';
import { getDeviceId } from './deviceId';
import {
  currentSyncEpoch,
  isSyncEpochCurrent,
} from './syncEpoch';
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
/**
 * P-PushDelta: '1' bila satu dorong PENUH sudah sukses (baseline).
 * Sebelum flag ini ada, dorong selalu penuh — penanda dirty yang
 * terkumpul sebelum baseline ikut dibersihkan sesudahnya.
 */
export const SYNC_PUSH_DELTA_INIT_KEY = 'sync-push-delta-init';
/** Stempel waktu sinkron terakhir yang sukses (auto-sync bersyarat). */
export const SYNC_LAST_SYNC_AT_KEY = 'sync-last-sync-at';
/**
 * Auto-sync berkala hanya jalan bila sinkron terakhir lebih tua
 * dari ini DAN tidak ada perubahan lokal yang belum terdorong.
 * Sebelumnya: sync penuh tiap 20 detik tanpa syarat — boros
 * request dan write D1 untuk pengguna yang tidak mengubah apa pun.
 */
export const AUTO_SYNC_STALE_MS = 60 * 60 * 1000;
const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SETTINGS_BYTES = 4096;
/**
 * P-Pull: batas halaman tarik per putaran sinkronisasi (10 x 1000
 * baris/koleksi = 10.000 baris — sama dengan batas total suka).
 * Bila masih hasMore sesudah ini, putaran ditandai belum selesai
 * (pullIncomplete) dan kursor aman disimpan supaya sinkronisasi
 * berikut melanjutkan — tidak pernah putar tanpa henti, tidak
 * pernah kehilangan data diam-diam.
 */
export const MAX_PULL_PAGES = 10;

/** Isi settings_json yang disinkronkan (versi 1). */
export interface SyncSettingsPayload {
  version: 1;
  eq: EqSettings;
  lyricsEnabled: boolean;
}

export interface SyncDeps {
  pull: (since: number) => Promise<PullData>;
  push: (body: PushBody) => Promise<{
    serverTime: number;
    applied: number;
    historyClearIgnored?: boolean;
  }>;
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
  epoch: number = currentSyncEpoch(),
): Promise<void> {
  // R18: berhenti tanpa menulis apa pun bila generasi berubah
  // (wipe dimulai di tengah putaran). Cek diletakkan TEPAT
  // sebelum tiap penulisan, bukan di awal iterasi: baca (await)
  // di antara cek dan tulis memberi jendela bagi wipe untuk
  // menghapus database di tengah jalan, dan tulis berikutnya
  // akan mendarat di database segar.
  const stale = () => !isSyncEpochCurrent(epoch);
  // 1) Playlist dulu (item butuh playlist-nya ada).
  for (const p of pull.playlists) {
    const local = await library.playlistByClientId(p.clientId);
    if (p.deletedAt !== null) {
      if (local) {
        if (stale()) return;
        await library.deletePlaylist(local.id, { quiet: true });
      }
      continue;
    }
    if (local) {
      if (stale()) return;
      await library.applyRemotePlaylist(local.id, {
        name: p.nama,
        description: p.deskripsi,
        updatedAt: p.updatedAt,
      });
    } else {
      if (stale()) return;
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
      if (stale()) return;
      await library.removeSongFromPlaylist(playlist.id, item.videoId, {
        quiet: true,
      });
      continue;
    }
    if (stale()) return;
    await library.ensureRemoteSong(item.videoId, item.title, item.artist);
    if (stale()) return;
    await library.insertPlaylistItemAt(playlist.id, item.videoId, item.posisi);
  }
  // 3) Suka.
  for (const like of pull.likes) {
    if (like.deletedAt !== null) {
      try {
        if (stale()) return;
        await library.setLiked(like.videoId, false, { quiet: true });
      } catch {
        // Lagu tidak ada di lokal: tidak ada yang perlu dibatalkan.
      }
      continue;
    }
    if (stale()) return;
    await library.ensureRemoteSong(like.videoId, like.title, like.artist);
    if (stale()) return;
    await library.setLiked(like.videoId, true, { quiet: true });
  }
  // 4) Riwayat (dedup per lagu+waktu).
  for (const h of pull.history) {
    if (stale()) return;
    await library.ensureRemoteSong(h.videoId, h.title, h.artist);
    if (await library.hasPlayEvent(h.videoId, h.playedAt)) continue;
    if (stale()) return;
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
        if (stale()) return;
        await getPlayerService().applySyncedEqSettings(payload.eq);
        const lyrics = await getLyricsService();
        // R20: cek generasi TEPAT sebelum penulisan ini juga —
        // dua await di atas memberi jendela bagi wipe, dan tanpa
        // cek ini preferensi lirik server bisa bangkit di database
        // segar sesudah wipe.
        if (stale()) return;
        await lyrics.setEnabled(payload.lyricsEnabled, { quiet: true });
        if (stale()) return;
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

/** Hasil pengumpulan dorong: body + snapshot penanda yang dikumpulkan. */
export interface CollectedPush {
  body: PushBody;
  /**
   * Penanda dirty pada saat pengumpulan dimulai — dibersihkan
   * berversi sesudah dorong sukses (syncNow). Pada dorong penuh
   * pun snapshot dikembalikan: penanda yang terkumpul sebelum
   * baseline ikut dibersihkan sesudah baseline sukses.
   */
  dirty: SyncDirtyEntry[];
  /** True bila ini dorong penuh baseline (flag init belum ada). */
  fullPush: boolean;
}

/**
 * Kumpulkan body dorong. Dorong pertama (flag init belum ada)
 * = PENUH seperti dulu (baseline). Sesudahnya = DELTA: hanya
 * baris bertanda dirty. Riwayat/tombstone/settings selalu
 * dikumpulkan seperti sebelumnya (sudah inkremental/marker-based).
 *
 * Snapshot dirty diambil di AWAL — edit yang terjadi selama
 * pengumpulan tidak ikut terhapus sesudah dorong (penghapusan
 * berversi di syncNow juga melindungi edit di tengah dorong).
 */
export async function collectPushBody(
  library: LibraryService,
  deviceId: string,
): Promise<CollectedPush> {
  const body: PushBody = { deviceId };
  const dirty = await library.listSyncDirty();
  const fullPush =
    (await library.getMeta(SYNC_PUSH_DELTA_INIT_KEY)) !== '1';

  // clientId per playlist lokal (diberi bila belum punya).
  const clientIds = new Map<number, string>();
  const getClientId = async (id: number): Promise<string | null> => {
    const cached = clientIds.get(id);
    if (cached) return cached;
    const row = await library.playlistById(id);
    if (!row) return null;
    let clientId = row.clientId;
    if (!clientId) {
      clientId = `${deviceId}:${id}`;
      await library.setPlaylistClientId(id, clientId);
    }
    clientIds.set(id, clientId);
    return clientId;
  };

  // Item playlist + metadata judul/artis untuk perangkat lain.
  const items: NonNullable<PushBody['playlistItems']> = [];
  const pushItems = async (
    playlistId: number,
    clientId: string,
    onlySongIds?: Set<string>,
  ): Promise<void> => {
    const songs = await library.playlistSongsAll(playlistId);
    const wanted = onlySongIds
      ? songs.filter((s) => onlySongIds.has(s.songId))
      : songs;
    if (wanted.length === 0) return;
    const views = await library.songsByIds(wanted.map((s) => s.songId));
    const byId = new Map(views.map((v) => [v.song.id, v]));
    for (const s of wanted) {
      const view = byId.get(s.songId);
      items.push({
        playlistClientId: clientId,
        videoId: s.songId,
        posisi: s.position,
        title: view?.song.title ?? null,
        artist: view?.artistNames.join(', ') ?? null,
      });
    }
  };

  if (fullPush) {
    // Baseline: seluruh state, seperti sebelum P-PushDelta.
    const playlists = await library.allPlaylists();
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
    for (const p of playlists) {
      await pushItems(p.id, clientIds.get(p.id) as string);
    }
    body.playlistItems = items;
    const liked = await library.allLikedSongs();
    body.likes = liked.map((v) => ({
      videoId: v.song.id,
      // likedAt tidak disimpan per lagu; dateModified dipakai
      // sebagai perkiraan terbaik (cukup untuk urutan tampilan).
      likedAt: v.song.dateModified,
      title: v.song.title,
      artist: v.artistNames.join(', ') || null,
    }));
  } else {
    // Delta: hanya baris bertanda dirty.
    const playlistRows = [];
    for (const d of dirty) {
      if (d.collection !== 'playlists') continue;
      const id = Number(d.ref);
      if (!Number.isFinite(id)) continue;
      const row = await library.playlistById(id);
      // Dihapus sesudah ditandai: tombstone menangani, lewati.
      if (!row) continue;
      playlistRows.push(row);
    }
    const playlistBodies: NonNullable<PushBody['playlists']> = [];
    for (const p of playlistRows) {
      const clientId = await getClientId(p.id);
      if (!clientId) continue;
      playlistBodies.push({
        clientId,
        nama: p.name,
        deskripsi: p.description,
      });
    }
    body.playlists = playlistBodies;

    // Item: kelompokkan per playlist supaya satu baca per playlist.
    const itemsByPlaylist = new Map<number, Set<string>>();
    for (const d of dirty) {
      if (d.collection !== 'playlist-items') continue;
      const sep = d.ref.indexOf(':');
      if (sep === -1) continue;
      const pid = Number(d.ref.slice(0, sep));
      if (!Number.isFinite(pid)) continue;
      let set = itemsByPlaylist.get(pid);
      if (!set) {
        set = new Set<string>();
        itemsByPlaylist.set(pid, set);
      }
      set.add(d.ref.slice(sep + 1));
    }
    for (const [pid, songIds] of itemsByPlaylist) {
      const clientId = await getClientId(pid);
      if (!clientId) continue;
      await pushItems(pid, clientId, songIds);
    }
    body.playlistItems = items;

    // Suka: hanya yang bertanda dirty DAN masih disukai
    // (batal suka membersihkan penandanya; pertahanan ganda).
    const likedIds = dirty
      .filter((d) => d.collection === 'likes')
      .map((d) => d.ref);
    if (likedIds.length > 0) {
      const views = await library.songsByIds(likedIds);
      body.likes = views
        .filter((v) => v.song.liked === 1)
        .map((v) => ({
          videoId: v.song.id,
          likedAt: v.song.dateModified,
          title: v.song.title,
          artist: v.artistNames.join(', ') || null,
        }));
    } else {
      body.likes = [];
    }
  }

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

  return { body, dirty, fullPush };
}

/** True bila body dorong punya isi yang layak dikirim ke server. */
function hasPushContent(body: PushBody): boolean {
  return (
    (body.playlists?.length ?? 0) > 0 ||
    (body.playlistItems?.length ?? 0) > 0 ||
    (body.likes?.length ?? 0) > 0 ||
    (body.history?.length ?? 0) > 0 ||
    (body.deletedPlaylists?.length ?? 0) > 0 ||
    (body.deletedPlaylistItems?.length ?? 0) > 0 ||
    (body.deletedLikes?.length ?? 0) > 0 ||
    body.settings !== undefined ||
    body.historyClearedBefore !== undefined
  );
}

/**
 * Auto-sync bersyarat (P-PushDelta): true bila ada alasan
 * menjalankan sync — belum pernah dorong penuh (butuh baseline),
 * ada perubahan lokal yang belum terdorong, atau sinkron
 * terakhir sudah lebih dari satu jam lalu (menangkap perubahan
 * dari perangkat lain). Selain itu: diam, hemat request.
 */
export async function shouldAutoSync(): Promise<boolean> {
  const library = await getLibraryService();
  if ((await library.getMeta(SYNC_PUSH_DELTA_INIT_KEY)) !== '1') {
    return true;
  }
  if (await library.hasSyncDirty()) return true;
  const last = Number((await library.getMeta(SYNC_LAST_SYNC_AT_KEY)) ?? 0);
  if (!Number.isFinite(last) || last <= 0) return true;
  return Date.now() - last > AUTO_SYNC_STALE_MS;
}

/**
 * Satu putaran sinkronisasi penuh (tarik lalu dorong).
 * `pullIncomplete` true bila tarik tidak selesai dalam putaran
 * ini (batas halaman / grup timestamp raksasa): kursor aman
 * tetap disimpan supaya putaran berikut melanjutkan, dan UI
 * memberi tahu pengguna — bukan diam-diam kehilangan data.
 */
export async function syncNow(
  deps: SyncDeps = defaultSyncDeps,
): Promise<{ serverTime: number; pushed: number; pullIncomplete: boolean }> {
  // R18: tangkap generasi di awal; bila wipe dimulai di tengah
  // putaran, berhenti sebelum dorong dan sebelum penanda sukses
  // (keduanya menulis ke database — dorong menulis clientId,
  // penanda menulis meta — dan tidak boleh mendarat di database
  // segar sesudah wipe).
  const epoch = currentSyncEpoch();
  const library = await getLibraryService();
  const deviceId = await getDeviceId();

  // 1) Tarik — berhalaman (P-Pull): ulangi selama server bilang
  // hasMore; kursor maju ke nextSince (minimum aman lintas
  // koleksi), BUKAN ke serverTime. Bila server lama (tanpa
  // hasMore), perilaku lama dipertahankan (satu halaman +
  // penanda serverTime) sampai worker baru ter-deploy.
  // Watermark = updatedAt tertinggi yang SEMUA baris di bawahnya
  // sudah ditarik; inilah yang disimpan sebagai penanda (bukan
  // jam dinding) supaya baris yang mendarat di tengah dorong
  // tidak terlewat. Sisa risiko: baris yang ditulis di milidetik
  // yang SAMA PERSIS dengan baris terakhir yang ditarik (jendela
  // 1 ms, perlu perangkat lain menulis di ms itu) — jauh lebih
  // sempit dari jendela lama (seluruh durasi dorong).
  const since = Number((await library.getMeta(SYNC_LAST_PULL_KEY)) ?? 0);
  const startCursor = Number.isFinite(since) ? since : 0;
  let cursor = startCursor;
  let watermark = startCursor;
  let pullIncomplete = false;
  let pullServerTime = 0;
  let modernServer = false;
  for (let page = 0; page < MAX_PULL_PAGES; page++) {
    const pull = await deps.pull(cursor);
    pullServerTime = pull.serverTime;
    if (pull.hasMore !== undefined) modernServer = true;
    await applyPull(library, pull, epoch);
    if (!isSyncEpochCurrent(epoch)) {
      return { serverTime: pull.serverTime, pushed: 0, pullIncomplete: false };
    }
    if (pull.tieOverflow === true) {
      // Grup timestamp raksasa: kursor TIDAK maju; halaman ini
      // sudah diterapkan (gabung idempotent), sisanya dicoba
      // lagi di sinkronisasi berikut. Tandai belum selesai.
      pullIncomplete = true;
      break;
    }
    if (pull.hasMore === true) {
      if (typeof pull.nextSince !== 'number') {
        // Server bilang ada lagi tapi tanpa kursor aman — jangan
        // tebak; berhenti dengan jujur di watermark terakhir.
        pullIncomplete = true;
        break;
      }
      watermark = pull.nextSince;
      cursor = pull.nextSince;
      if (page === MAX_PULL_PAGES - 1) pullIncomplete = true;
      continue;
    }
    // Halaman terakhir (atau server lama): watermark = max
    // updatedAt yang benar-benar ditarik di halaman ini.
    if (
      typeof pull.maxUpdatedAt === 'number' &&
      pull.maxUpdatedAt > watermark
    ) {
      watermark = pull.maxUpdatedAt;
    }
    break;
  }

  // 2) Dorong (batch 100 per koleksi). Snapshot dirty dipakai
  // untuk pembersihan berversi sesudah dorong sukses.
  const { body, dirty } = await collectPushBody(library, deviceId);
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
  // P-PushDelta: tidak ada isi yang perlu didorong -> lewati
  // request sama sekali (dulu: 1 ronde kosong setiap sync).
  const rounds = hasPushContent(body)
    ? Math.max(1, ...Object.values(chunks).map((c) => c.length))
    : 0;
  let serverTime = pullServerTime;
  let pushed = 0;
  // S8a: bila server mengabaikan hapus riwayat (baru boleh sekali
  // per 24 jam), penanda lokal DIPERTAHANKAN supaya sinkronisasi
  // berikut mencoba lagi — bukan dibuang (riwayat server belum
  // terhapus, dan penanda yang hilang berarti clear tidak pernah
  // sampai ke server).
  let clearIgnored = false;
  for (let i = 0; i < rounds; i++) {
    // R18: wipe di tengah dorong — berhenti, jangan lanjut ronde.
    if (!isSyncEpochCurrent(epoch)) {
      return { serverTime, pushed, pullIncomplete: false };
    }
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
    // Penanda hapus riwayat hanya dikirim di ronde pertama.
    if (i === 0 && result.historyClearIgnored) clearIgnored = true;
  }

  // 3) Penanda sukses (hanya bila SEMUA dorong berhasil).
  // R18: cek sekali lagi — penanda menulis meta ke database,
  // dan penanda basi di database segar akan membuat tarik
  // pertama sesudah masuk lagi melewatkan perubahan server.
  if (!isSyncEpochCurrent(epoch)) {
    return { serverTime, pushed, pullIncomplete: false };
  }
  await library.deleteTombstones(tombstones.map((t) => t.key));
  // P-PushDelta: bersihkan penanda yang terdorong — berversi,
  // jadi edit yang terjadi di tengah sync tetap tertanda dan
  // terdorong di putaran berikut. Lalu set flag init (baseline
  // selesai, termasuk bila dorong dilewati karena kosong: tidak
  // ada isi = baseline selesai secara vakum) + stempel sinkron.
  for (const d of dirty) {
    await library.clearSyncDirty(d.collection, d.ref, d.value);
  }
  await library.setMeta(SYNC_PUSH_DELTA_INIT_KEY, '1');
  await library.setMeta(SYNC_LAST_SYNC_AT_KEY, String(Date.now()));
  // P-Pull: penanda = watermark data yang benar-benar ditarik
  // (server modern) — atau serverTime seperti dulu (server lama
  // tanpa field paginasi, masa transisi deploy).
  await library.setMeta(
    SYNC_LAST_PULL_KEY,
    String(modernServer ? watermark : serverTime),
  );
  if (body.history) {
    const maxPlayedAt = Math.max(...body.history.map((h) => h.playedAt));
    await library.setMeta(SYNC_HISTORY_PUSHED_KEY, String(maxPlayedAt));
  }
  if (body.historyClearedBefore !== undefined && !clearIgnored) {
    await library.setMeta(SYNC_HISTORY_CLEARED_KEY, '');
  }
  if (body.settings) {
    await setSettingsAppliedAt(serverTime);
  }
  await library.pruneTombstones(Date.now() - TOMBSTONE_RETENTION_MS);

  return { serverTime, pushed, pullIncomplete };
}
