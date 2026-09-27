/**
 * Utilidades de texto: normalización de claves y similitud entre títulos.
 */

/** Quita diacríticos (á → a, ñ → n) y símbolos; minúsculas; espacios colapsados. */
export function normalizeKey(str) {
  if (!str) return '';
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, ' ')
    .replace(/\b(the|a|an|el|la|los|las|un|una|le|les|der|die|das)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const bigrams = (s) => {
  const out = new Map();
  const str = s.replace(/\s+/g, ' ');
  for (let i = 0; i < str.length - 1; i += 1) {
    const bg = str.slice(i, i + 2);
    out.set(bg, (out.get(bg) || 0) + 1);
  }
  return out;
};

/*
 * Variantes internas que trabajan con CLAVES ya normalizadas: la similitud se
 * calcula cientos de veces por ejecución y `normalizeKey` es caro. Las funciones
 * públicas mantienen la firma original (aceptan texto en bruto).
 */
const diceOfKeys = (ka, kb) => {
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  const ba = bigrams(ka);
  const bb = bigrams(kb);
  let inter = 0;
  for (const [bg, n] of ba) inter += Math.min(n, bb.get(bg) || 0);
  const total = [...ba.values()].reduce((x, y) => x + y, 0) + [...bb.values()].reduce((x, y) => x + y, 0);
  return total ? (2 * inter) / total : 0;
};

const jaccardOfKeys = (ka, kb) => {
  const ta = new Set(ka.split(' ').filter(Boolean));
  const tb = new Set(kb.split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
};

const similarityOfKeys = (ka, kb) => {
  if (!ka || !kb) return 0;
  let score = Math.max(diceOfKeys(ka, kb), jaccardOfKeys(ka, kb));
  if (ka !== kb && (ka.includes(kb) || kb.includes(ka))) {
    score = Math.max(score, Math.min(ka.length, kb.length) / Math.max(ka.length, kb.length) + 0.15);
  }
  return Math.min(1, score);
};

/** Coeficiente de Sørensen–Dice sobre bigramas de caracteres (0-1). */
export function diceCoefficient(a, b) {
  return diceOfKeys(normalizeKey(a), normalizeKey(b));
}

/** Jaccard sobre tokens (palabras). */
export function tokenJaccard(a, b) {
  return jaccardOfKeys(normalizeKey(a), normalizeKey(b));
}

/**
 * Similitud combinada (máximo de Dice y Jaccard). Añade un pequeño bonus si
 * una cadena contiene íntegramente a la otra (títulos con subtítulo largo).
 */
export function titleSimilarity(a, b) {
  return similarityOfKeys(normalizeKey(a), normalizeKey(b));
}

/** "2nd Season", "Season 2", "Temporada 3"... */
export function hasSeasonMarker(text) {
  return /(?:\b(?:season|temporada|saison|staffel)\b|\d(?:st|nd|rd|th)\s+season)/i.test(String(text || ''));
}

/**
 * Ajusta una similitud base con señales que el coeficiente solo no ve:
 *  - prefijo de palabra largo ("Frieren" ⊂ "Frieren Beyond Journey's End")
 *  - la consulta pide una temporada y el candidato no la menciona
 *  - el año coincide o se aleja
 *
 * `yearWindow` / `yearPenalty` / `yearBonus` permiten el criterio de cada API.
 */
export function adjustTitleScore(baseScore, query, titles, {
  year = null,
  itemYear = null,
  yearWindow = 3,
  yearPenalty = 0.15,
  yearBonus = 0.1,
} = {}) {
  let score = baseScore;
  const list = (Array.isArray(titles) ? titles : [titles]).filter(Boolean);
  const q = normalizeKey(query);
  if (q.length >= 7) {
    for (const t of list) {
      const kt = normalizeKey(t);
      if (kt && kt !== q && (kt.startsWith(`${q} `) || q.startsWith(`${kt} `))) score = Math.max(score, 0.78);
    }
  }
  if (hasSeasonMarker(query) && !list.some((t) => hasSeasonMarker(t))) score -= 0.22;
  if (year && itemYear) {
    const diff = Math.abs(Number(itemYear) - Number(year));
    if (Number.isFinite(diff)) {
      if (diff <= 1) score += yearBonus;
      else if (diff > yearWindow) score -= yearPenalty;
    }
  }
  return score;
}

/** Devuelve el candidato con mayor similitud respecto a cualquiera de los títulos dados. */
export function bestSimilarity(query, candidateTitles) {
  const q = normalizeKey(query);
  if (!q) return 0;
  let best = 0;
  for (const t of candidateTitles) {
    if (!t) continue;
    const s = similarityOfKeys(q, normalizeKey(t));
    if (s > best) best = s;
  }
  return best;
}

/** "2nd", "3rd", "4th"... */
export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}
