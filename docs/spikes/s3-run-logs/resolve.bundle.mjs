// app/tests/e2e/spikes/canary.ts
var INNERTUBE_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
var INNERTUBE_HOST = "www.youtube.com";
var CONFIG_URL = "https://raw.githubusercontent.com/adiprmx/laras/config-v1/player-config.json";
var WEB_REMIX = {
  name: "WEB_REMIX",
  version: "1.20261110.04.00",
  clientId: "67",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  context: { clientName: "WEB_REMIX", clientVersion: "1.20261110.04.00" },
  requiresScript: true
};
var MWEB = {
  name: "MWEB",
  version: "2.20260708.05.00",
  clientId: "2",
  userAgent: "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  context: { clientName: "MWEB", clientVersion: "2.20260708.05.00" },
  requiresScript: true
};
var ANDROID_VR = {
  name: "ANDROID_VR",
  version: "1.65.10",
  clientId: "14",
  userAgent: "com.google.android.youtube/21.26.364 (Linux; U; Android 14; Pixel 8) gzip",
  context: {
    clientName: "ANDROID_VR",
    clientVersion: "1.65.10",
    androidSdkVersion: 34
  },
  requiresScript: false
};
var CLIENT_FALLBACK_ORDER = [
  WEB_REMIX,
  MWEB,
  ANDROID_VR
];
var BEST_QUALITY_ITAG_ORDER = [251, 140, 250, 249, 139];
function describeStreamUrl(url, itag) {
  let host = "?";
  try {
    host = new URL(url).hostname;
  } catch {
    host = "url-tidak-valid";
  }
  const edge = host.endsWith(".googlevideo.com") ? "*.googlevideo.com" : host;
  return `host=${edge} itag=${itag} urlLen=${url.length}`;
}
function isAllowedStreamUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    if (u.username !== "" || u.password !== "") return false;
    return u.hostname === "googlevideo.com" || u.hostname.endsWith(".googlevideo.com");
  } catch {
    return false;
  }
}

// app/tests/e2e/spikes/resolve.ts
var SEARCH_QUERY = "lagu indonesia populer";
var PLAYER_TIMEOUT_MS = 6e4;
var SEARCH_TIMEOUT_MS = 6e4;
var CONFIG_TIMEOUT_MS = 3e4;
async function postYoutubei(path, body, client, timeoutMs) {
  const t0 = Date.now();
  const res = await fetch(
    `https://${INNERTUBE_HOST}${path}?key=${INNERTUBE_API_KEY}&prettyPrint=false`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": client.userAgent,
        "X-YouTube-Client-Name": client.clientId,
        "X-YouTube-Client-Version": client.version,
        Accept: "application/json",
        "Accept-Language": "en-US,en;q=0.9"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    }
  );
  const text = await res.text();
  return { status: res.status, ms: Date.now() - t0, json: JSON.parse(text) };
}
async function fetchPlayerConfig() {
  const t0 = Date.now();
  const res = await fetch(CONFIG_URL, {
    signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`config HTTP ${res.status}`);
  const json = await res.json();
  const stsByHash = {};
  for (const [hash, v] of Object.entries(json.playerHashes ?? {})) {
    if (typeof v.signatureTimestamp === "number") {
      stsByHash[hash] = v.signatureTimestamp;
    }
  }
  return { stsByHash, fetchedMs: Date.now() - t0 };
}
async function fetchVisitorData(client) {
  const { json, ms } = await postYoutubei(
    "/youtubei/v1/search",
    { context: { client: { ...client.context } }, query: SEARCH_QUERY },
    client,
    SEARCH_TIMEOUT_MS
  );
  const responseContext = json.responseContext;
  const visitorData = typeof responseContext?.visitorData === "string" && responseContext.visitorData.length > 0 ? responseContext.visitorData : null;
  return { visitorData, ms };
}
function parseAudioFormats(json) {
  const playability = json.playabilityStatus?.status ?? "?";
  const streamingData = json.streamingData ?? {};
  const topSabr = Boolean(streamingData.serverAbrStreamingUrl);
  const formats = [];
  for (const f of streamingData.adaptiveFormats ?? []) {
    const mimeType = String(f.mimeType ?? "");
    if (!mimeType.startsWith("audio/")) continue;
    const hasUrl = typeof f.url === "string" && f.url.length > 0;
    const hasCipher = typeof f.signatureCipher === "string" && f.signatureCipher.length > 0;
    const isSabr = Boolean(
      f.serverAbrStreamingUrl || !hasUrl && !hasCipher && topSabr
    );
    formats.push({
      itag: Number(f.itag ?? 0),
      mimeType,
      bitrate: Number(f.bitrate ?? 0),
      url: hasUrl ? f.url : void 0,
      signatureCipher: hasCipher ? f.signatureCipher : void 0,
      serverAbrStreamingUrl: typeof f.serverAbrStreamingUrl === "string" ? f.serverAbrStreamingUrl : void 0,
      isSabr
    });
  }
  return { playability, formats };
}
function pickAudioFormat(formats) {
  const usable = formats.filter(
    (f) => !f.isSabr && (Boolean(f.url) || Boolean(f.signatureCipher))
  );
  for (const itag of BEST_QUALITY_ITAG_ORDER) {
    const found = usable.find((f) => f.itag === itag);
    if (found) return found;
  }
  usable.sort((a, b) => b.bitrate - a.bitrate);
  return usable[0] ?? null;
}
async function createResolver() {
  const config = await fetchPlayerConfig();
  const hashes = Object.keys(config.stsByHash);
  if (hashes.length === 0) throw new Error("config tanpa playerHashes");
  const sts = Math.max(...Object.values(config.stsByHash));
  let visitorData = null;
  try {
    const vd = await fetchVisitorData(WEB_REMIX);
    visitorData = vd.visitorData;
  } catch {
    visitorData = null;
  }
  async function fetchPlayer(song, client) {
    const context = { ...client.context };
    if (visitorData) context.visitorData = visitorData;
    const contentPlaybackContext = {
      vis: 0,
      splay: false,
      autoCaptionsDefaultOn: false,
      autonavState: "STATE_OFF",
      html5Preference: "HTML5_PREF_WANTS",
      lact: []
    };
    if (client.requiresScript) {
      contentPlaybackContext.signatureTimestamp = sts;
    }
    const t0 = Date.now();
    const { json } = await postYoutubei(
      "/youtubei/v1/player",
      {
        context: { client: context },
        videoId: song.videoId,
        playbackContext: { contentPlaybackContext },
        racyCheckOk: true,
        contentCheckOk: true
      },
      client,
      PLAYER_TIMEOUT_MS
    );
    const ms = Date.now() - t0;
    const { playability, formats } = parseAudioFormats(json);
    const picked = pickAudioFormat(formats);
    return {
      client: client.name,
      playability,
      audioFormats: formats.length,
      pickedItag: picked?.itag ?? null,
      pickedDirect: Boolean(picked?.url),
      pickedCipher: Boolean(picked?.signatureCipher),
      ms,
      picked
    };
  }
  async function resolve(song) {
    const t0 = Date.now();
    const attempts = [];
    for (const client of CLIENT_FALLBACK_ORDER) {
      try {
        const attempt = await fetchPlayer(song, client);
        attempts.push(attempt);
        const picked = attempt.picked;
        if (!picked) continue;
        if (!picked.url) {
          continue;
        }
        if (!isAllowedStreamUrl(picked.url)) continue;
        return {
          song,
          client: client.name,
          itag: picked.itag,
          mimeType: picked.mimeType,
          bitrate: picked.bitrate,
          url: picked.url,
          totalBytes: null,
          resolveMs: Date.now() - t0,
          attempts
        };
      } catch (e) {
        attempts.push({
          client: client.name,
          playability: "ERROR",
          audioFormats: 0,
          pickedItag: null,
          pickedDirect: false,
          pickedCipher: false,
          ms: Date.now() - t0,
          error: String(e).slice(0, 160)
        });
      }
    }
    throw new Error(
      `resolve gagal untuk ${song.videoId} (${song.title}): ` + attempts.map((a) => `${a.client}=${a.playability}`).join(", ")
    );
  }
  return { resolve, sts, visitorData };
}
async function resolveViaVr(song, visitorData) {
  const context = { ...ANDROID_VR.context };
  if (visitorData) context.visitorData = visitorData;
  const t0 = Date.now();
  const { json } = await postYoutubei(
    "/youtubei/v1/player",
    {
      context: { client: context },
      videoId: song.videoId,
      playbackContext: {
        contentPlaybackContext: {
          vis: 0,
          splay: false,
          autoCaptionsDefaultOn: false,
          autonavState: "STATE_OFF",
          html5Preference: "HTML5_PREF_WANTS",
          lact: []
        }
      },
      racyCheckOk: true,
      contentCheckOk: true
    },
    ANDROID_VR,
    PLAYER_TIMEOUT_MS
  );
  const { formats } = parseAudioFormats(json);
  const picked = pickAudioFormat(formats);
  if (!picked?.url || !isAllowedStreamUrl(picked.url)) {
    throw new Error(
      `re-resolve VR gagal untuk ${song.videoId}: format=${formats.length} picked=${picked?.itag ?? "tidak ada"}`
    );
  }
  return {
    url: picked.url,
    itag: picked.itag,
    mimeType: picked.mimeType.split(";")[0],
    ms: Date.now() - t0
  };
}
export {
  createResolver,
  describeStreamUrl,
  fetchPlayerConfig,
  fetchVisitorData,
  resolveViaVr
};
