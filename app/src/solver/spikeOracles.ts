/**
 * Data uji solver: cipher nyata + oracle hasil solve dari APK.
 *
 * Dipakai bersama oleh tes mesin Vitest (`solverEngine.test.ts`) dan
 * halaman spike browser (`spikePage.ts`) supaya keduanya menguji nilai
 * yang sama persis.
 *
 * Sumber:
 * - Cipher itag 251 + oracle sig fad7e4e9: fixture respons player
 *   WEB_REMIX asli + `sig-result.json` (spike P1 APK, terverifikasi
 *   lawan oracle pytubefix 11.2.1).
 * - Cipher URL + oracle n ad8d59ae: `ad8d59ae_n_diag.log` (koordinator
 *   Fase 2, 16 Nov 2026, tes live lolos).
 * - b559f50c: tanpa oracle tersimpan; verifikasi lewat kesepakatan
 *   antar-mesin (QuickJS-WASM == eval V8).
 *
 * Nilai-nilai ini adalah data uji dari respons publik YouTube yang
 * sudah kedaluwarsa (expire 2026); tidak ada kredensial di dalamnya.
 */

/** Cipher nyata itag 251, video hhn-nGSuenM (fixture respons WEB_REMIX). */
export const kCipheredS =
  'jRjRsE0s2JYwsgIhANxTopy7_Nskx0LmkH7_xjlqTtd-njduMVA-h65v0CmTAiEA1qRgyGhRv_U7pKc6tQvoWYH9EnZq2WKuvjzS5pK4TbQ=';

export const kCipherUrlFad =
  'https://rr4---sn-2o5ua5-50.googlevideo.com/videoplayback?expire=1794777439&ei=_8z5asr4Ma2Fy_sPpdTYsAs&ip=2606%3A54c1%3A1%3A230%3A%3A11%3A21c&id=o-ADYbjxY4C8Hv2USoFqWdfKMKrbPQzF3fCEGLs_LAR5og&itag=251&source=youtube&requiressl=yes&xpc=EgVo2aDSNQ%3D%3D&met=1794755839%2C&mh=1h&mm=31%2C29&mn=sn-2o5ua5-50%2Csn-aj5ua5-5a&ms=au%2Crdu&mv=m&mvi=4&pl=63&rms=au%2Cau&pcm2=no&initcwndbps=26493000&bui=AZFAFb-lPNIlM_McPJgNw0ZtH7EGDXB-W6fXHjad2X_Afvi_i3NBCjB8nZ2S9q_UU_Uo9v9hKugOPVL0&spc=nfZ8ZgeqFDZM9CNBjlKdY4pVw6u4h6NNAvMLXq7KAOJT9BMm8J5xXKtlSrIbjHLUCA&vprv=1&svpuc=1&mime=audio%2Fwebm&ns=QmY_Oo1bzmpNuVEeRMrTDGEa&rqh=1&gir=yes&clen=4808098&dur=268.461&lmt=1791028528145293&mt=1794755129&fvip=3&epbp=1&keepalive=yes&fexp=51565115%2C52338435&c=WEB_REMIX&sefc=1&txp=5532234&n=AN4ZrqC9mKvCumNnl&sparams=expire%2Cei%2Cip%2Cid%2Citag%2Csource%2Crequiressl%2Cxpc%2Cpcm2%2Cbui%2Cspc%2Cvprv%2Csvpuc%2Cmime%2Cns%2Crqh%2Cgir%2Cclen%2Cdur%2Clmt&lsparams=met%2Cmh%2Cmm%2Cmn%2Cms%2Cmv%2Cmvi%2Cpl%2Crms%2Cinitcwndbps&lsig=APaTxxMwRgIhAPjdaU5Fr-tHrovqIRDfsrT_5VQf2UCBz7YV7n8N_eSbAiEAz3dXhlJOyIyJ8tPQGUzWBGZRykNi9-LEQMMq9VGuwK8%3D';

/** Oracle sig fad7e4e9 (`sig-result.json`, terverifikasi pytubefix). */
export const kOracleSigFad =
  'AE0s2JYwRgIhANxTopy7_Nskx0LmkH7_xjlqTtd-njduMVs-h65v0CmTAiEA1qRgyGhjv_U7pKc6tQvoWYH9EnZq2WKuvjzS5pK4TbQ%3D';

/** Cipher URL ad8d59ae dari `ad8d59ae_n_diag.log` (n input avtzUIaCevXHJKjFf). */
export const kCipherUrlAd8 =
  'https://rr3---sn-vgqsknzz.googlevideo.com/videoplayback?expire=1794882455&ei=N2f7avTsJbytir4P_-3H-Qg&ip=2a04%3A4e41%3A4%3A47c8%3A%3Aa480%3Ac7c8&id=o-ALBaBp9MuYwMo1pQqAN3bPySx9YZvRxm-966GCDX6Pgu&itag=140&source=youtube&requiressl=yes&xpc=EgVo2aDSNQ%3D%3D&cps=303&met=1794860855%2C&mh=1h&mm=31%2C29&mn=sn-vgqsknzz%2Csn-ojvgq5-54&ms=au%2Crdu&mv=m&mvi=3&pl=49&rms=au%2Cau&pcm2=no&initcwndbps=6321625&bui=AZFAFb83gygrwTtknzCnY_JRB0tYwpraZLgqFkxgSPZnVNaQcZq2gxNtfqF1aV_iWes1NXySiQJrkrRT&spc=nfZ8ZoHyZ0H-iq2MgdP98YTb8OaNwNCf8mQ6-KEmm_oozHO9nDurEDvRjjQC-VZWKw&vprv=1&svpuc=1&mime=audio%2Fmp4&ns=ZP_qXnjeWmNva4r78Xc0LbUa&rqh=1&gir=yes&clen=4346070&dur=268.492&lmt=1791028326157561&mt=1794860384&fvip=3&epbp=1&keepalive=yes&fexp=51565116&c=WEB_REMIX&sefc=1&txp=5532234&n=avtzUIaCevXHJKjFf&sparams=expire%2Cei%2Cip%2Cid%2Citag%2Csource%2Crequiressl%2Cxpc%2Cpcm2%2Cbui%2Cspc%2Cvprv%2Csvpuc%2Cmime%2Cns%2Crqh%2Cgir%2Cclen%2Cdur%2Clmt&lsparams=cps%2Cmet%2Cmh%2Cmm%2Cmn%2Cms%2Cmv%2Cmvi%2Cpl%2Crms%2Cinitcwndbps&lsig=APaTxxMwRgIhAKOHjC0Jddbl3xQ73E3RC-xNKAaE1XyVO1sIMtbL79bfAiEA4wGuzCm-qHzo1ll93qmvBncYz4iPjsxyv0Ovxkw2oy4%3D';

/** Oracle transform n ad8d59ae (`ad8d59ae_n_diag.log`). */
export const kOracleNAd8 = 'M3WoXUP3VXHCEA';

/** Cipher URL per hash untuk solve (b559f50c memakai URL fad7e4e9). */
export const kCipherUrlByHash: Record<string, string> = {
  fad7e4e9: kCipherUrlFad,
  ad8d59ae: kCipherUrlAd8,
  b559f50c: kCipherUrlFad,
};

/** Dekode persen berulang (maks 2 putaran) sampai stabil. */
export function fullyDecode(value: string): string {
  let current = value;
  for (let i = 0; i < 2; i++) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    } catch {
      break;
    }
  }
  return current;
}
