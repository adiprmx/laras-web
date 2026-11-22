// Deklarasi tipe kontrak API sync (P-Types) — pendamping
// contract.js. Bentuk wire yang SAMA dengan validator runtime di
// sana; app mengimpor tipe ini (bukan mendefinisikan ulang).
// Bila bentuk berubah, ubah contract.js DAN file ini bersamaan.

export interface AuthMeData {
  displayName: string;
  provider: string;
}

export interface RemotePlaylist {
  clientId: string;
  nama: string;
  deskripsi: string | null;
  updatedAt: number;
  deletedAt: number | null;
}

export interface RemotePlaylistItem {
  playlistClientId: string;
  videoId: string;
  posisi: number;
  title: string | null;
  artist: string | null;
  updatedAt: number;
  deletedAt: number | null;
}

export interface RemoteLike {
  videoId: string;
  likedAt: number;
  title: string | null;
  artist: string | null;
  updatedAt: number;
  deletedAt: number | null;
}

export interface RemoteHistoryEvent {
  videoId: string;
  playedAt: number;
  secondsPlayed: number;
  title: string | null;
  artist: string | null;
  updatedAt: number;
}

export interface PullData {
  serverTime: number;
  /** P-Pull: masih ada halaman berikut (hanya server baru; tidak ada = server lama). */
  hasMore?: boolean;
  /** P-Pull: kursor `since` halaman berikut; null bila tidak ada / tidak aman. */
  nextSince?: number | null;
  /** P-Pull: updatedAt terbesar di halaman ini (4 koleksi; settings tidak ikut). */
  maxUpdatedAt?: number;
  /** P-Pull: grup timestamp >1000 baris — kursor tidak boleh maju. */
  tieOverflow?: boolean;
  playlists: RemotePlaylist[];
  playlistItems: RemotePlaylistItem[];
  likes: RemoteLike[];
  history: RemoteHistoryEvent[];
  settings: { settingsJson: string; updatedAt: number } | null;
}

export interface PushBody {
  deviceId: string;
  playlists?: Array<{
    clientId: string;
    nama: string;
    deskripsi: string | null;
  }>;
  playlistItems?: Array<{
    playlistClientId: string;
    videoId: string;
    posisi: number;
    title: string | null;
    artist: string | null;
  }>;
  likes?: Array<{
    videoId: string;
    likedAt: number;
    title: string | null;
    artist: string | null;
  }>;
  history?: Array<{
    videoId: string;
    playedAt: number;
    secondsPlayed: number;
    title: string | null;
    artist: string | null;
  }>;
  deletedPlaylists?: Array<{ clientId: string }>;
  deletedPlaylistItems?: Array<{
    playlistClientId: string;
    videoId: string;
  }>;
  deletedLikes?: Array<{ videoId: string }>;
  settings?: { settingsJson: string };
  historyClearedBefore?: number;
}

export interface PushData {
  serverTime: number;
  applied: number;
  /** Baris tombstone/item yang disapu push ini (Blue 7, S14). */
  pruned?: number;
  /** Entri yang ditolak karena bukan milik pendorong (R11). */
  skippedNotOwned?: number;
  /** Entri yang dilewati karena melewati batas total per pengguna (S7). */
  skippedOverLimit?: {
    playlists: number;
    playlistItems: number;
    likes: number;
    history: number;
  };
  /** Batas total server (arsitektur §4.3). */
  limits?: {
    playlists: number;
    itemsPerPlaylist: number;
    likes: number;
    history: number;
  };
  /** Hapus riwayat diabaikan server (S8a: maks sekali per 24 jam). */
  historyClearIgnored?: boolean;
  /** Detik sampai hapus riwayat boleh dicoba lagi (S8a). */
  historyClearRetryAfterSeconds?: number;
}

/** Envelope respons worker: { success, data } atau { success: false, error }. */
export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

// Validator runtime (contract.js): pesan galat atau null bila valid.
export declare function isNonEmptyString(v: unknown, maxLen: number): boolean;
export declare function isOptionalString(v: unknown, maxLen: number): boolean;
export declare function isSafeInt(v: unknown): boolean;
export declare function validatePushBody(body: unknown): string | null;
export declare function validatePullResponse(data: unknown): string | null;
export declare function validatePushData(data: unknown): string | null;
