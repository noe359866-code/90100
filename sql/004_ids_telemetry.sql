-- Telemetría de resolución de IDs (OPCIONAL pero muy recomendable)
-- =================================================================
-- El enriquecedor (paso 6) puede registrar en cada fila cuándo se ha mirado por
-- última vez, qué API la resolvió, con qué confianza y cuántos intentos lleva.
-- Con eso no se vuelven a consultar a diario las mismas obras imposibles, que es
-- exactamente lo que quema la cuota de AniList/TMDB (y provoca los 429).
--
-- Si tu tabla YA tiene estas columnas (ids_checked_at, ids_source,
-- ids_confidence, ids_attempts), no hace falta que ejecutes este script.
--
-- Idempotente: puedes ejecutarlo tantas veces como quieras.

alter table public.torrents add column if not exists ids_checked_at  timestamp with time zone;
alter table public.torrents add column if not exists ids_source      text;
alter table public.torrents add column if not exists ids_confidence  double precision;
alter table public.torrents add column if not exists ids_attempts    integer not null default 0;

-- El enriquecedor filtra por estas dos cosas, así que el índice acelera el paso.
create index if not exists torrents_ids_checked_at_idx on public.torrents using btree (ids_checked_at);

-- Ajustes relacionados (variables de entorno / repository variables):
--   ENRICH_TRACK_IDS_COLUMNS  true     → usar estas columnas (si existen)
--   ENRICH_RECHECK_AFTER_DAYS 14       → días antes de reintentar una obra fallida
--   ENRICH_MAX_ATTEMPTS       3        → intentos antes de darla por perdida (0 = ilimitado)
