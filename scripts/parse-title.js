#!/usr/bin/env node
/**
 * Utilidad de depuración: `npm run parse -- "Título del torrent"`
 * Imprime el resultado del parser para uno o varios títulos.
 */
import { parseTitle, buildSearchVariants } from '../src/parser/titleParser.js';

const titles = process.argv.slice(2);
if (!titles.length) {
  console.error('Uso: npm run parse -- "Título 1" ["Título 2" ...]');
  process.exit(1);
}
for (const t of titles) {
  const p = parseTitle(t);
  console.log(JSON.stringify({ ...p, searchVariants: buildSearchVariants(p) }, null, 2));
}
