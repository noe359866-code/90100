/**
 * Normalizadores de valores sueltos ya presentes en la BD (codec, quality).
 * Devuelven `null` si el valor no es reconocible.
 */

const CODEC_RULES = [
  ['h264', /^(?:x\.?264|h\.?264|avc|avc1|h264\/avc|mpeg-?4 avc)$/i],
  ['hevc', /^(?:x\.?265|h\.?265|hevc|hvc1|hev1|h265\/hevc)$/i],
  ['av1', /^av0?1$/i],
  ['xvid', /^(?:xvid|divx|mpeg-?4(?: asp)?|mp4v)$/i],
  ['vp9', /^vp0?9$/i],
  ['vp8', /^vp0?8$/i],
  ['mpeg2', /^(?:mpeg-?2|mpeg2video|mpg2)$/i],
  ['vc1', /^(?:vc-?1|wmv3?|wvc1)$/i],
];

/** @returns {string|null} 'h264' | 'hevc' | 'av1' | 'xvid' | 'vp9' | 'vp8' | 'mpeg2' | 'vc1' | null */
export function normalizeCodec(value) {
  if (!value) return null;
  const v = String(value).trim().toLowerCase();
  if (!v) return null;
  for (const [name, re] of CODEC_RULES) if (re.test(v)) return name;
  // Cadenas más largas ("x265 10bit", "H.264 High")
  if (/(?:x|h)\.?265|hevc/i.test(v)) return 'hevc';
  if (/(?:x|h)\.?264|avc/i.test(v)) return 'h264';
  if (/\bav1\b/i.test(v)) return 'av1';
  if (/xvid|divx/i.test(v)) return 'xvid';
  if (/vp9/i.test(v)) return 'vp9';
  if (/mpeg-?2/i.test(v)) return 'mpeg2';
  if (/vc-?1/i.test(v)) return 'vc1';
  return null;
}

/** @returns {string|null} '2160p' | '1080p' | '720p' | '576p' | '480p' | '360p' | null */
export function normalizeQuality(value) {
  if (!value) return null;
  const v = String(value).trim().toLowerCase().replace(/\s+/g, '');
  if (!v) return null;
  // Coincidencia exacta primero. El fallback embebido exige límite de dígito:
  // si no, "1720" se leía como 720p.
  if (/^(?:2160p?|4k|uhd|8k|4320p?|3840x2160)$/.test(v)) return '2160p';
  if (/^(?:1080[pi]?|fhd|fullhd|1920x1080)$/.test(v)) return '1080p';
  if (/^(?:720p?|hd|hdready|1280x720)$/.test(v)) return '720p';
  if (/^(?:576p?|pal)$/.test(v)) return '576p';
  if (/^(?:480p?|sd|ntsc|dvd)$/.test(v)) return '480p';
  if (/^(?:360p?)$/.test(v)) return '360p';
  if (/^(?:cam|ts|tc|telesync|hdcam|hdts)$/.test(v)) return null; // fuentes, no resoluciones
  if (/(?:^|[^0-9])(?:2160p?|4320p?|3840x2160)(?:[^0-9]|$)|(?:^|[^a-z0-9])(?:4k|uhd|8k)(?:[^a-z0-9]|$)/.test(v)) return '2160p';
  if (/(?:^|[^0-9])1080[pi]?(?:[^0-9]|$)|(?:^|[^a-z0-9])(?:fhd|fullhd|1920x1080)(?:[^a-z0-9]|$)/.test(v)) return '1080p';
  if (/(?:^|[^0-9])720p?(?:[^0-9]|$)|(?:^|[^a-z0-9])1280x720(?:[^a-z0-9]|$)/.test(v)) return '720p';
  if (/(?:^|[^0-9])576p?(?:[^0-9]|$)/.test(v)) return '576p';
  if (/(?:^|[^0-9])480p?(?:[^0-9]|$)/.test(v)) return '480p';
  if (/(?:^|[^0-9])360p?(?:[^0-9]|$)/.test(v)) return '360p';
  return null;
}

/** @returns {'movie'|'series'|'anime'|null} */
export function normalizeType(value) {
  if (!value) return null;
  const v = String(value).trim().toLowerCase();
  if (['movie', 'movies', 'film', 'pelicula', 'película'].includes(v)) return 'movie';
  if (['series', 'serie', 'tv', 'show', 'tvshow', 'tv show', 'episode'].includes(v)) return 'series';
  if (['anime', 'animes'].includes(v)) return 'anime';
  return null;
}
