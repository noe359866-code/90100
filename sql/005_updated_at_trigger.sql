-- `updated_at`: que sólo lo toque el scraper (OPCIONAL)
-- =====================================================
-- El purgador de muertos (paso 3) considera "muerto" un torrent con 0 seeders
-- que lleva más de DEAD_AFTER_DAYS sin actualizarse. El problema: si tienes un
-- trigger `before update` que refresca `updated_at` en CADA update, las propias
-- escrituras del mantenimiento (normalizador, enriquecedor...) reactivan filas
que el scraper no ha tocado en meses, y el paso 3 deja de borrar nada.
--
-- Además, en el schema de ejemplo hay DOS triggers con la misma función
-- (trg_torrents_updated_at y update_torrents_updated_at): se ejecutan los dos.
--
-- Este script deja un único trigger que sólo salta cuando cambian columnas que
-- maneja el scraper. Ajusta la lista a las columnas que escribe tu scraper.
--
-- Idempotente. Si prefieres que el mantenimiento también refresque `updated_at`,
-- no ejecutes este script (el comportamiento por defecto ya es así).

drop trigger if exists update_torrents_updated_at on public.torrents;
drop trigger if exists trg_torrents_updated_at on public.torrents;

create trigger trg_torrents_updated_at
  before update of info_hash, size_bytes, seeders, leechers, source_tracker, release_group, hdr_format, channels, file_index
  on public.torrents
  for each row
  execute function public.update_torrents_updated_at();
