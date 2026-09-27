# torrents-maintenance

Script Node.js (sin framework, una sola dependencia: `@supabase/supabase-js`) que mantiene
la tabla `torrents` de Supabase limpia, normalizada, enriquecida y deduplicada.
Está pensado para ejecutarse en **GitHub Actions** de forma programada.

## Qué hace (en orden)

| # | Paso (`STEPS`) | Descripción |
|---|----------------|-------------|
| 1 | `adult`     | Borra torrents cuyo `title` contiene palabras de contenido adulto. Preselección en servidor (regex `imatch`) + verificación en cliente con lista blanca (*xXx*, *Sex Education*, *Saving Private Ryan*…). |
| 2 | `size`      | Borra fakes: `movie` < 150 MB, `series`/`anime` < 30 MB (umbrales configurables; ignora tamaño 0/NULL por defecto). |
| 3 | `dead`      | Borra torrents con `seeders = 0` y `updated_at` con más de 30 días. |
| 4/5 | `normalize` | Parser inteligente sobre `title` → `title_text` (título limpio), `type`, `season`/`episode`/`absolute_episode`, `codec`, `quality`; arrays `audio`/`subtitles` en minúsculas, canónicos, sin duplicados ni basura. |
| 6 | `enrich`    | Para huérfanos: AniList (GraphQL) + Kitsu → `anilist_id`, `mal_id`, `kitsu_id`; TMDB (si hay API key) → `tmdb_id` + `imdb_id`. Una consulta por obra, no por torrent; validación por similitud de título + año. |
| 7 | `dedupe`    | Agrupa por obra (`imdb_id` / `tmdb_id` / `anilist_id` / `kitsu_id`, unidos con union-find) + episodio y conserva **sólo el mejor `spanish` y el mejor `english`**. |

Sólo se escriben en la BD las filas que realmente cambian. `DRY_RUN=true` ejecuta todo sin modificar nada.

## Puesta en marcha

### 1. Base de datos (una vez, SQL Editor de Supabase)

```sql
-- Índices recomendados (opcional pero muy aconsejable en tablas grandes)
\i sql/001_indexes.sql
-- RPC de actualización masiva (opcional; sin ella el script hace UPDATE fila a fila)
\i sql/002_bulk_update_rpc.sql
```

> Si tu tabla no tiene alguna columna (p. ej. `mal_id` o `title_text`), quita esa línea de la RPC
> y ajusta `CLEAN_TITLE_COLUMN`.

### 2. Secrets del repositorio (Settings → Secrets and variables → Actions)

| Secret | Obligatorio | Descripción |
|--------|-------------|-------------|
| `SUPABASE_URL` | ✅ | `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Service role key (salta RLS; nunca la uses en cliente) |
| `TMDB_API_KEY` | ➖ | API key v3 o token de lectura v4. Sin ella no se enriquecen movies/series. |

Los parámetros no sensibles pueden definirse como **Repository variables** (`vars.*`) o pasarse
como inputs al lanzar el workflow manualmente (`workflow_dispatch`: `dry_run`, `steps`, `log_level`, `enrich_max_lookups`).

#### "Puse la TMDB_API_KEY y sigue apareciendo el aviso"

Es el fallo más habitual y casi nunca es del código. El workflow sólo lee
`secrets.TMDB_API_KEY` (con `vars.TMDB_API_KEY` como alternativa), así que revisa en este orden:

1. **Nombre exacto**: `TMDB_API_KEY`, en mayúsculas. `TMDB_KEY` o `tmdb_api_key` llegan vacíos.
2. **Pestaña correcta**: Settings → Secrets and variables → Actions → **Secrets**.
   Si la guardaste en la pestaña **Variables** ahora también funciona (`vars.*`), pero si la
   guardaste dentro de un **Environment** (Settings → Environments → *tu entorno* → Secrets),
   el job **no** la recibe salvo que el workflow declare `environment: <nombre>`.
3. **Relanza el workflow**: los secrets se inyectan al iniciar el job; editar el secret no
   afecta a una ejecución ya en marcha.
4. **Espacios o saltos de línea al copiar**: el script los recorta, pero una key truncada da 401.
5. **Tipo de credencial**: valen la API key v3 (32 chars) y el token de lectura v4 (JWT largo);
   el script detecta cuál es y la usa en el formato correcto.

Para comprobarlo sin esperar al workflow, en local:

```bash
cp .env.example .env      # pega aquí la MISMA key
npm ci
npm run doctor            # muestra qué variables ve el proceso y valida la key contra TMDB
```

`npm run doctor` no escribe en la base de datos. Si la key es válida verás
`TMDB: credencial válida`; si no, te dirá si es 401 (key rechazada), error de red o vacía.

### 3. Workflow

`.github/workflows/torrents-maintenance.yml` se ejecuta a diario (04:15 UTC) y bajo demanda.
Usa `concurrency` para evitar solapes y publica un resumen en la pestaña del job.

**Recomendación:** la primera vez lánzalo con `dry_run = true` y `log_level = debug` y revisa el log.

### Ejecución local

```bash
npm ci
cp .env.example .env   # rellena credenciales
set -a && source .env && set +a
npm run dry-run                       # simula
STEPS=normalize,dedupe npm start      # ejecuta sólo esos pasos
npm run parse -- "[SubsPlease] Sousou no Frieren - 09 (1080p) [ABCDEF12].mkv"   # depurar el parser
npm test
```

## Configuración

Todas las opciones están documentadas en [`.env.example`](.env.example) y `src/config.js`. Las más relevantes:

| Variable | Defecto | Efecto |
|----------|---------|--------|
| `DRY_RUN` | `false` | No escribe nada |
| `STEPS` | `all` | Subconjunto de pasos (`adult,size,dead,normalize,enrich,dedupe`) |
| `MIN_MOVIE_MB` / `MIN_SERIES_MB` | `150` / `30` | Umbrales anti-fakes |
| `DEAD_AFTER_DAYS` | `30` | Antigüedad para purgar torrents con 0 seeders |
| `NORMALIZE_OVERWRITE_TYPE` | `false` | Sobrescribir `type` existente cuando el parser está seguro |
| `NORMALIZE_OVERWRITE_EPISODES` | `false` | Sobrescribir season/episode existentes |
| `ENRICH_MAX_LOOKUPS` | `300` | Obras resueltas vía API por ejecución (el resto, en la siguiente) |
| `DEDUP_OTHER_LANGUAGE_POLICY` | `delete` | `keep` para no tocar torrents en otros idiomas (francés, alemán…) |
| `DEDUP_UNKNOWN_LANGUAGE_AS` | `english` | Grupo para torrents sin información de idioma (`english`/`spanish`/`keep`) |
| `MAX_DELETE_RATIO` | `0.95` | Aborta un paso que quiera borrar más de ese % de filas evaluadas |

## El parser de títulos

`src/parser/titleParser.js` es un motor RegEx tolerante a fallos. Soporta, entre otros:

- **Tipo**: `anime` (grupos `[SubsPlease]`, `[Erai-raws]`, `[Judas]`, `[PuyaSubs!]`… + CRC `[A1B2C3D4]`, kanji, `OVA`, partículas romaji), `series` (hay temporada/episodio), `movie`.
- **Episodios**: `S02E09`, `S2E9`, `S02E09-E10`, `Season 2 Episode 9`, `Temporada 2 Capítulo 9`, `2x09`, `1x01 al 1x10`, `Cap.209` (formato español), `Show 2 - 09`.
- **Absolutos (anime)**: `- 09`, `- 1085`, `[09]`, `Ep.9`, `Episode 87`, `第09話`, `#09`, `Naruto Shippuden 297`. Con `S04E28 - 87` guarda 28 como episodio y 87 como absoluto.
- **Packs**: `S01`, `S01-S03`, `Season 2`, `2nd Season`, `COMPLETE`, `Temporada Completa`.
- **Metadatos**: año (prioriza `(2019)`; distingue *Blade Runner 2049*), 2160p/4K/1080p/720p, fuente (BluRay, WEB-DL, HDTV, CAM, TS…), códec (h264/hevc/av1/xvid), audio (aac/ac3/eac3/dts/truehd/atmos), HDR/DV, 10 bit, contenedor, grupo de release.
- **Idiomas**: sólo analiza la zona de metadatos (no el título → *The English Patient* no es "english"), distingue Castellano/Latino, subtítulos (`VOSE`, `Sub Esp`, `[Multiple Subtitle][ENG][SPA-LA]`) y aplica perfiles por grupo de fansub.
- **Título limpio**: quita webs (`www.newpct1.com`, `ver.pelicula.online.`), tags, extensión, puntos scene (respetando *S.W.A.T.* y *Mr. Robot*), `AKA`, ruido (`Descargar`, `Torrent`).

## Deduplicación para Stremio

Por cada `obra + episodio` se puntúa cada torrent:

```
score = log2(1 + seeders) × 20  +  compatibilidad
```

| Factor | Puntos |
|--------|--------|
| Códec | H.264 +40 · HEVC +25 · AV1 −20 · XviD/MPEG-2 −30 |
| Contenedor | MP4 +15 · MKV +10 · AVI −25 · WMV −40 · ISO −100 |
| Fuente | BluRay/WEB-DL +12 · WEBRip +8 · Remux +8 · DVD −8 · CAM −90 · TS −80 · TC −70 |
| Resolución | 1080p +15 · 720p +8 · 2160p +6 · 480p −6 |
| Audio | AAC +8 · AC3/E-AC3 +6 · DTS −8 · TrueHD −10 |
| HDR | Dolby Vision −25 · HDR10 −8 |
| Extras | dual audio +4 · REPACK +2 · >30 GB −10 · Hi10P −5 |

Duplicar los seeders vale 20 puntos, por lo que la compatibilidad sólo decide entre torrents con
seeders comparables (un CAM con 120 seeders pierde contra un BluRay con 80; con 5000 ganaría).

Grupos de idioma: **spanish** = audio castellano/latino **o** subtítulos en español; **english** =
audio o subtítulos en inglés. Un torrent dual puede ganar ambos grupos (se conserva una sola fila).
Los torrents sin información de idioma se asignan al grupo `DEDUP_UNKNOWN_LANGUAGE_AS` (por defecto
`english`, que es lo habitual en releases sin etiquetar). Los que tienen audio y subtítulos
explícitos en otros idiomas se eliminan (`DEDUP_OTHER_LANGUAGE_POLICY=delete`) o se conservan.

## Supuestos sobre el esquema

- `id` es la PK (uuid o bigint) — se usa para paginación keyset.
- `title_text` guarda el título limpio (cámbialo con `CLEAN_TITLE_COLUMN`).
- `audio` y `subtitles` son `text[]`. `season`, `episode`, `absolute_episode` enteros.
- `updated_at` refleja la última comprobación del scraper: **el script no la modifica** (la RPC tampoco).
  Si tienes un trigger `moddatetime` sobre `updated_at`, ten en cuenta que las normalizaciones la refrescarán.
- Anime: en la clave de episodio, "sin temporada" y "temporada 1" se consideran el mismo episodio.

## Estructura

```
src/
  index.js               orquestador + resumen para GitHub Actions
  config.js              variables de entorno
  db.js                  Supabase: paginación, borrado por lotes, RPC/fallback
  parser/
    titleParser.js       motor RegEx
    languages.js         normalización y detección de idiomas
    animeGroups.js       perfiles de grupos de fansub
    normalizers.js       codec / quality / type
  apis/  anilist.js kitsu.js tmdb.js
  steps/ 01-adultFilter 02-sizeFilter 03-deadPurger 04-normalizer 05-enricher 06-deduplicator
sql/     001_indexes.sql 002_bulk_update_rpc.sql
test/    unitarios + pipeline de integración con Supabase falso en memoria
```
