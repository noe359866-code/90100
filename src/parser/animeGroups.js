/**
 * Grupos de release habituales en anime.
 *
 * Cada entrada define el "perfil" por defecto de idiomas del grupo, usado
 * cuando el título no incluye información explícita:
 *   - audio:     idiomas de audio típicos del grupo
 *   - subtitles: idiomas de subtítulos típicos del grupo
 *
 * La clave se compara en minúsculas y sin el sufijo "!" (p. ej. "PuyaSubs!").
 */

const JP_EN = { audio: ['japanese'], subtitles: ['english'] };
const JP_MULTI = { audio: ['japanese'], subtitles: ['english', 'spanish', 'latino'] };
const JP_ES = { audio: ['japanese'], subtitles: ['spanish'] };
const JP_LAT = { audio: ['japanese'], subtitles: ['latino'] };
const DUAL_EN = { audio: ['japanese', 'english'], subtitles: ['english'] };
const RAW = { audio: ['japanese'], subtitles: [] };

export const ANIME_GROUPS = new Map(Object.entries({
  // --- Fansubs / encoders en inglés --------------------------------------
  'subsplease': JP_EN,
  'erai-raws': JP_MULTI,
  'horriblesubs': JP_EN,
  'judas': DUAL_EN,
  'ember': DUAL_EN,
  'ember encodes': DUAL_EN,
  'asw': JP_EN,
  'anime time': DUAL_EN,
  'animetime': DUAL_EN,
  'dkb': JP_EN,
  'kametsu': DUAL_EN,
  'yameii': DUAL_EN,
  'golumpa': DUAL_EN,
  'cleo': JP_EN,
  'cerberus': JP_EN,
  'reaktor': JP_EN,
  'kaizoku': JP_EN,
  'animekaizoku': JP_EN,
  'animerg': DUAL_EN,
  'moozzi2': RAW,
  'beatrice-raws': RAW,
  'vcb-studio': RAW,
  'tsundere-raws': RAW,
  'ohys-raws': RAW,
  'leopard-raws': RAW,
  'nc-raws': JP_EN,
  'lilith-raws': JP_EN,
  'anime-raws': RAW,
  'deadmau-raws': RAW,
  'seed-raws': RAW,
  'philosophy-raws': RAW,
  'coalgirls': JP_EN,
  'commie': JP_EN,
  'underwater': JP_EN,
  'fff': JP_EN,
  'damedesuyo': JP_EN,
  'doki': JP_EN,
  'chihiro': JP_EN,
  'gjm': JP_EN,
  'kaleido': JP_EN,
  'sallysubs': JP_EN,
  'mtbb': JP_EN,
  'lostyears': DUAL_EN,
  'sweetsub': JP_EN,
  'uccuss': JP_EN,
  'cbm': DUAL_EN,
  'toonshub': DUAL_EN,
  'trix': DUAL_EN,
  'arid': DUAL_EN,
  'pog42': JP_EN,
  'neodesu': JP_EN,
  'nyanpasu': JP_EN,
  'hakata ramen': JP_EN,
  'edge': JP_EN,
  'yuri': JP_EN,
  'exiled-destiny': DUAL_EN,
  'anime land': DUAL_EN,
  'anidl': DUAL_EN,
  'hi10': JP_EN,
  'thora': JP_EN,
  'ctr': JP_EN,
  'sxales': JP_EN,
  'baaro': JP_EN,
  'mysteria': JP_EN,
  'nep_blanc': JP_EN,
  'shimatta': JP_EN,
  'setsugen': JP_EN,
  'pantsu': JP_EN,
  'crow': JP_EN,
  'animeout': JP_EN,
  'anime4life': JP_EN,
  'anime-chap': JP_EN,
  'varyg': DUAL_EN,
  'sam': JP_EN,
  'ani': JP_EN,
  'hianime': JP_EN,
  'hidive': JP_EN,
  'crunchyroll': JP_EN,
  'cr': JP_EN,
  'gst': JP_EN,
  'smol': JP_EN,
  'zza': JP_EN,
  'shirσ': JP_EN,
  'ssa': JP_EN,
  'nan0': JP_EN,
  'aergia': JP_EN,
  'okay-subs': JP_EN,
  'newbsubs': JP_EN,
  'bakedfish': JP_EN,
  'deanzel': JP_EN,
  'kawaiika-raws': RAW,
  'raws-maji': RAW,

  // --- Fansubs en español -------------------------------------------------
  'puyasubs': JP_ES,
  'puya': JP_ES,
  'animeflv': JP_ES,
  'anime-underground': JP_ES,
  'au': JP_ES,
  'animeid': JP_ES,
  'nihonjin': JP_ES,
  'tanoshii': JP_ES,
  'hunter subs': JP_ES,
  'backbeard': JP_ES,
  'animelatino': JP_LAT,
  'jkanime': JP_LAT,
  'latinoanime': JP_LAT,
  'monoschinos': JP_LAT,
  'animefenix': JP_LAT,
  'shinsen': JP_ES,
  'inari': JP_ES,
  'friki no fansub': JP_ES,
  'rakuen': JP_ES,
  'tenshi': JP_ES,
  'kuroneko': JP_ES,
  'anime yabai': JP_ES,
  'anime-yabai': JP_ES,
  'mct': JP_ES,
  'rakuen no fansub': JP_ES,
  'ñyuum': JP_ES,
  'eldoradosubs': JP_ES,
  'ataraxia': JP_ES,
  'sakura fansub': JP_ES,
  'fenixfansub': JP_ES,
  'akiba-kei': JP_ES,
  'nanikano': JP_ES,
  'nanikano fansub': JP_ES,
  'shin-sekai': JP_ES,
  'animeyt': JP_LAT,
  'animejl': JP_LAT,
}));

/**
 * Busca el perfil de un grupo por nombre (tolerante a mayúsculas, "!" y
 * sufijos como " Subs"). Devuelve `null` si es desconocido.
 */
export function lookupAnimeGroup(name) {
  if (!name) return null;
  const key = String(name).trim().toLowerCase().replace(/!+$/, '').replace(/\s+/g, ' ');
  if (ANIME_GROUPS.has(key)) return { name: key, ...ANIME_GROUPS.get(key) };

  // Variantes: "Erai-raws (Multi)" → "erai-raws"; "SubsPlease Subs" → "subsplease"
  const simplified = key.split(/[\s(]/)[0];
  if (simplified && ANIME_GROUPS.has(simplified)) return { name: simplified, ...ANIME_GROUPS.get(simplified) };
  return null;
}
