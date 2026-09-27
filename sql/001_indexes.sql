-- Índices recomendados para que los pasos de mantenimiento sean rápidos.
-- Ejecutar una vez en el SQL Editor de Supabase. Todos son idempotentes.
--
-- NOTA: `CREATE INDEX CONCURRENTLY` no puede ejecutarse dentro de una transacción;
-- el SQL Editor de Supabase ejecuta cada sentencia por separado, así que funciona.

-- Paso 1 (filtro adulto): búsqueda regex case-insensitive sobre title.
create extension if not exists pg_trgm;
create index concurrently if not exists torrents_title_trgm_idx
  on public.torrents using gin (title gin_trgm_ops);

-- Paso 2 (anti-fakes): type + size_bytes
create index concurrently if not exists torrents_type_size_idx
  on public.torrents (type, size_bytes);

-- Paso 3 (muertos): seeders + updated_at
create index concurrently if not exists torrents_seeders_updated_idx
  on public.torrents (seeders, updated_at);

-- Paso 6 (enriquecimiento): huérfanos por tipo (índices parciales, muy pequeños)
create index concurrently if not exists torrents_missing_tmdb_idx
  on public.torrents (type) where tmdb_id is null;
create index concurrently if not exists torrents_missing_anilist_idx
  on public.torrents (type) where anilist_id is null;
create index concurrently if not exists torrents_missing_kitsu_idx
  on public.torrents (type) where kitsu_id is null;

-- Paso 7 (deduplicación): agrupación por obra + episodio
create index concurrently if not exists torrents_imdb_ep_idx
  on public.torrents (imdb_id, season, episode) where imdb_id is not null;
create index concurrently if not exists torrents_tmdb_ep_idx
  on public.torrents (tmdb_id, season, episode) where tmdb_id is not null;
create index concurrently if not exists torrents_anilist_ep_idx
  on public.torrents (anilist_id, season, episode) where anilist_id is not null;

-- Paginación keyset: la PK sobre id ya cubre `order by id` + `id > $1`.
