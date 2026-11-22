/**
 * srcset sampul (P-React19).
 *
 * Parser sudah membatasi thumbnail ke lebar <=544px, tapi baris
 * daftar hanya menampilkan 48px — mengunduh 480px untuk tiap
 * baris membuang ~500 KB-1 MB per halaman 50 lagu di layar 1x.
 * Helper ini menurunkan varian ukuran dari URL yang sudah ada:
 *
 * - i.ytimg.com/vi/<id>/<varian>.jpg(.webp): varian default
 *   (120px), mqdefault (320px), hqdefault (480px) selalu ada
 *   untuk setiap video. Query (?sqp=...) dibuang — URL telanjang
 *   adalah bentuk kanonis yang selalu jalan.
 * - lh3.googleusercontent.com/...=w<N>-h<M>...: parameter
 *   resize Google ditulis ulang ke 96/240/544 (sisa sufiks
 *   dipertahankan). Bentuk =s<N> ditangani juga.
 *
 * Pola lain (ggpht, host tak dikenal) -> null: pakai src tunggal
 * seperti dulu, jangan tebak URL yang bisa 404.
 *
 * `sizes` diteruskan apa adanya dari pemanggil (lebar tampil).
 */
export interface CoverSrcSet {
  srcSet: string;
  sizes: string;
}

const YTIMG_RE =
  /^https:\/\/i\.ytimg\.com\/vi(_webp)?\/([A-Za-z0-9_-]+)\/[^/?#]+\.(jpg|webp)(?:[?#].*)?$/;
const LH3_WH_RE = /^(https:\/\/lh3\.googleusercontent\.com\/[^=]+)=w\d+-h\d+(.*)$/;
const LH3_S_RE = /^(https:\/\/lh3\.googleusercontent\.com\/[^=]+)=s\d+(.*)$/;

export function coverSrcSet(
  url: string | null | undefined,
  sizes: string,
): CoverSrcSet | null {
  if (!url) return null;
  const yt = YTIMG_RE.exec(url);
  if (yt) {
    const dir = yt[1] === '_webp' ? 'vi_webp' : 'vi';
    const ext = yt[3];
    const base = `https://i.ytimg.com/${dir}/${yt[2]}/`;
    return {
      srcSet: [
        `${base}default.${ext} 120w`,
        `${base}mqdefault.${ext} 320w`,
        `${base}hqdefault.${ext} 480w`,
      ].join(', '),
      sizes,
    };
  }
  const wh = LH3_WH_RE.exec(url);
  if (wh) {
    return {
      srcSet: [96, 240, 544]
        .map((w) => `${wh[1]}=w${w}-h${w}${wh[2]} ${w}w`)
        .join(', '),
      sizes,
    };
  }
  const s = LH3_S_RE.exec(url);
  if (s) {
    return {
      srcSet: [96, 240, 544]
        .map((w) => `${s[1]}=s${w}${s[2]} ${w}w`)
        .join(', '),
      sizes,
    };
  }
  return null;
}
