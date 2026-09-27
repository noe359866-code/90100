-- RPC de actualización masiva usada por el normalizador y el enriquecedor.
--
-- Recibe un array JSON `[{ "id": "...", "patch": { "col": valor, ... } }, ...]`
-- y actualiza SÓLO las columnas presentes en cada `patch` (las demás se conservan).
-- Un único round-trip actualiza cientos de filas (frente a un UPDATE por fila vía REST).
--
-- El script funciona igualmente sin esta función (hace fallback a UPDATE fila a fila),
-- pero con ella es órdenes de magnitud más rápido en tablas grandes.
--
-- Si tu tabla no tiene alguna de estas columnas (p. ej. `title_text` o `mal_id`),
-- elimina la línea correspondiente antes de ejecutar.
--
-- IMPORTANTE: no toca `updated_at` a propósito: esa columna refleja la frescura del
-- scraper y la usa el purgador de muertos. Si tienes un trigger que actualiza
-- `updated_at` en cada UPDATE, valora excluir las columnas de metadatos.

create or replace function public.bulk_update_torrents(updates jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer := 0;
begin
  update public.torrents as t
  set
    type             = case when u.patch ? 'type'             then p.type             else t.type end,
    season           = case when u.patch ? 'season'           then p.season           else t.season end,
    episode          = case when u.patch ? 'episode'          then p.episode          else t.episode end,
    absolute_episode = case when u.patch ? 'absolute_episode' then p.absolute_episode else t.absolute_episode end,
    title_text       = case when u.patch ? 'title_text'       then p.title_text       else t.title_text end,
    codec            = case when u.patch ? 'codec'            then p.codec            else t.codec end,
    quality          = case when u.patch ? 'quality'          then p.quality          else t.quality end,
    audio            = case when u.patch ? 'audio'            then p.audio            else t.audio end,
    subtitles        = case when u.patch ? 'subtitles'        then p.subtitles        else t.subtitles end,
    imdb_id          = case when u.patch ? 'imdb_id'          then p.imdb_id          else t.imdb_id end,
    tmdb_id          = case when u.patch ? 'tmdb_id'          then p.tmdb_id          else t.tmdb_id end,
    anilist_id       = case when u.patch ? 'anilist_id'       then p.anilist_id       else t.anilist_id end,
    kitsu_id         = case when u.patch ? 'kitsu_id'         then p.kitsu_id         else t.kitsu_id end,
    mal_id           = case when u.patch ? 'mal_id'           then p.mal_id           else t.mal_id end
  from (
    select (x->>'id') as id, (x->'patch') as patch
    from jsonb_array_elements(updates) as x
  ) as u
  cross join lateral jsonb_populate_record(null::public.torrents, u.patch) as p
  where t.id::text = u.id;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- Sólo el service_role (usado por el script) debe poder invocarla.
revoke all on function public.bulk_update_torrents(jsonb) from public, anon, authenticated;
grant execute on function public.bulk_update_torrents(jsonb) to service_role;
