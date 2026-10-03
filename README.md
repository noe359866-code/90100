# torrents-maintenance

Script Node.js (sin framework, una sola dependencia: `@supabase/supabase-js`) que mantiene
la tabla `torrents` de Supabase limpia, normalizada, enriquecida y deduplicada.
Está pensado para ejecutarse en **GitHub Actions** de forma programada. Requiere **Node.js 22 o superior**.

## Qué hace (en orden)

| # | Paso (`STEPS`) | Descripción |
|---|----------------|-------------|
| 1 | `adult`     | Borra torrents cuyo `title` contiene palabras de contenido adulto. Preselección en servidor (regex `imatch`) + verificación en cliente con lista blanca (*xXx*, *Sex Education*, *Saving Private Ryan*…). |
| 2 | `size`      | Borra fakes: `movie` < 150 MB, `series`/`anime` < 30 MB (umbrales configurables; ignora tamaño 0/NULL por defecto). |
| 3 | `dead`      | Borra torrents con `seeders = 0` y `updated_at` con más de 30 días. |
| 4/5 | `normalize` | Parser inteligente sobre `title` → `title_text` (título limpio), `type`, `season`/`episode`/`absolute_episode`, `codec`, `quality`; arrays `audio`/`subtitles` en minúsculas, canónicos, sin duplicados ni basura. |
| 6 | `enrich`    | Para huérfanos: **la vía más barata primero**. Si la fila ya trae `imdb_id`, TMDB `/find` da el `tmdb_id` exacto en 1 llamada (sin homónimos); si ya trae otro ID externo, los mappings de Kitsu (anilist↔kitsu↔mal) dan el resto sin gastar cuota de AniList. Sin IDs: **TMDB primero** (si hay API key) → `tmdb_id` + `imdb_id`; en anime después AniList (GraphQL) + Kitsu → `anilist_id`, `mal_id`, `kitsu_id`. Una consulta por obra, no por torrent; validación por similitud de título + año. Si TMDB no encuentra el anime con las variantes del parser, reintenta al final con el título canónico de AniList/Kitsu. Si AniList está saturado (429), Kitsu y TMDB resuelven igualmente (los IDs de AniList/MAL se rescatan vía mappings de Kitsu). |
| 7 | `dedupe`    | Agrupa por IDs y, por defecto, también por título normalizado + año para enlazar filas con/sin IDs; separa por episodio y conserva **como máximo 1 `spanish` y 1 `english`**. Si el episodio no se puede identificar, no borra nada; entre doblaje y VOSE casi empatados gana el doblaje. |

Sólo se escriben en la BD las filas que realmente cambian. `DRY_RUN=true` ejecuta todo sin modificar nada.

## Puesta en marcha

### 1. Base de datos (una vez, SQL Editor de Supabase)

```sql
-- Índices recomendados (opcional pero muy aconsejable en tablas grandes)
\i sql/001_indexes.sql
-- RPC de actualización masiva (opcional; sin ella el script hace UPDATE fila a fila)
\i sql/002_bulk_update_rpc.sql
-- Telemetría de IDs: evita reintentar a diario las mismas obras imposibles
\i sql/004_ids_telemetry.sql
-- (Opcional) que `updated_at` sólo lo refresque el scraper, no el mantenimiento
\i sql/005_updated_at_trigger.sql
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
El workflow reenvía las variables de [`.env.example`](.env.example); un `dry_run: false` del
dispatch no lo pisa una variable `DRY_RUN=true`.

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

### Rate limits (errores 429 de AniList / Kitsu / TMDB)

AniList es el más estricto: permite ~30 peticiones/minuto y responde `429` con
`Retry-After: 60` en cuanto te pasas. Desde GitHub Actions las IPs de los runners
están muy usadas, así que es fácil acabarse el presupuesto sin hacer nada raro.
El cliente ya se defiende solo:

- **Ventana deslizante**: como máximo `ANILIST_RPM` peticiones por minuto, serializadas
  entre todos los workers (no se acumulan ráfagas aunque haya concurrencia).
- **Penalty box**: cada `429` congela *todas* las peticiones de esa API durante el
  `Retry-After` (o un backoff exponencial creciente) y baja la tasa a la mitad.
  Los reintentos de una petición también respetan esa pausa (reintentar antes
  sólo provoca otro 429 y alarga el bloqueo).
- **Recuperación**: si pasa una ventana completa sin `429`, la tasa sube de nuevo
  poco a poco (+25%) hasta el máximo configurado.
- **Interruptor**: con varios `429` seguidos, la API se apaga 10 minutos y falla rápido
  en lugar de reintentar sin parar (reintentar sólo empeora el bloqueo). Las obras
  afectadas quedan para la próxima ejecución.
- **Fallback Kitsu/TMDB**: TMDB va primero (es la API con más cuota), así que
  `tmdb_id`/`imdb_id` no dependen de AniList. Si AniList está saturado (429) o no
  encuentra la obra, Kitsu la resuelve por búsqueda de texto y sus *mappings* rescatan
  `anilist_id` y `mal_id`. Es decir: los `429` de AniList retrasan poco, en vez de
  dejar la obra sin resolver.
- **Vías exactas antes que búsquedas**: con 20 req/min, cada consulta de AniList
  cuesta 3 s de job. Por eso, cuando la fila ya trae un ID se usa la referencia
  (`/find` de TMDB para `imdb_id`, mappings de Kitsu para anilist/kitsu/mal), que
  además es exacta: cero homónimos y, medido, **cero consultas de AniList** en esas
  obras (1-2 llamadas a Kitsu, 90 req/min, en lugar de 3 s de cola de AniList).
- **Sin caché de errores**: una petición fallida no se cachea, así que no envenena
  las siguientes búsquedas del mismo título.

Ajustes si ves muchos `429` en el log: baja `ANILIST_RPM` (p. ej. `12`) y
`ENRICH_MAX_LOOKUPS` (p. ej. `150`) para que la ejecución quepa en el tiempo.
Al final del paso `enrich` verás un resumen: `límites de tasa alcanzados → AniList: 34×429 (tasa final 5/20)`.

### Requisitos de la tabla (comprobado contra un schema real)

Columnas que usa el script y sus particularidades:

| Columna | Nota |
|---------|------|
| `id` | paginación keyset (`order by id` + `id > último`) |
| `title`, `title_text` | `title_text` es donde se guarda el título limpio (`CLEAN_TITLE_COLUMN`) |
| `imdb_id` | se escribe sólo si cumple `^tt[0-9]+$` (respeta el CHECK de la tabla) |
| `tmdb_id`, `anilist_id`, `kitsu_id`, `mal_id` | numéricos; `0` se trata como "vacío" |
| `type` | `movie` \| `series` \| `anime`. Si es `NOT NULL DEFAULT 'movie'` (como en el schema de ejemplo) la consulta "sin tipo" no devuelve nada: es normal |
| `season`, `episode`, `absolute_episode` | se rellenan si están a NULL |
| `codec`, `quality` | se recortan a 20 caracteres para no chocar con `varchar(20)` |
| `audio`, `subtitles` | arrays de texto |
| `size_bytes`, `seeders`, `updated_at` | pasos 2 y 3 |
| `ids_checked_at`, `ids_source`, `ids_confidence`, `ids_attempts` | **telemetría** (ver más abajo) |

Dos avisos sobre el schema de ejemplo:

1. **`updated_at` y los triggers**: si tienes un trigger `before update` que refresca
   `updated_at` en cada UPDATE, las escrituras del propio mantenimiento reactivan
   filas que el scraper no toca desde hace meses y el purgador de muertos (paso 3)
   deja de borrar nada. En el schema de ejemplo hay además **dos triggers con la misma
   función**. Solución: `sql/005_updated_at_trigger.sql` (deja un solo trigger que
   sólo salta con columnas del scraper).
2. **`file_index`**: no se usa. Como hay un índice único sólo sobre `info_hash_clean`,
   no puede haber dos filas por torrent, así que el deduplicador por obra+episodio
   es seguro.

### Temporadas: por qué AniList/Kitsu no ven el título pelado

AniList, Kitsu y MAL tienen **una ficha por temporada**; TMDB tiene **una ficha por serie**
(con las temporadas dentro). Por eso, en una obra con `season > 1`:

- a AniList/Kitsu se les pregunta sólo por las variantes que identifican la temporada
  (`Título 2nd Season`, `Título Season 2`, `Título 2`),
- a TMDB se le pregunta también por el título pelado (es donde está la serie correcta).

Sin esa distinción, una T2 podía recibir el `anilist_id` de la T1: metadatos y
episodios equivocados en Stremio, y —peor— la deduplicación agrupa por ID, así que
temporadas distintas podían fusionarse y borrarse torrents legítimos. Si ninguna
variante de temporada casa, la obra se queda sin ID y se reintenta en la siguiente
ejecución (con telemetría, `ENRICH_RECHECK_AFTER_DAYS`): es preferible a guardar un ID erróneo.

### Telemetría de IDs (`ids_checked_at`, `ids_source`, `ids_confidence`, `ids_attempts`)

Si la tabla tiene esas columnas (o las añades con `sql/004_ids_telemetry.sql`), el
enriquecedor:

- **no vuelve a consultar** una obra fallida hasta pasar `ENRICH_RECHECK_AFTER_DAYS`
  (14 por defecto) o hasta que se agoten `ENRICH_MAX_ATTEMPTS` (3) intentos;
- guarda **qué API** resolvió cada obra (`ids_source`: `anilist+kitsu+tmdb`, `tmdb`…)
  y con qué **similitud** (`ids_confidence`), para poder auditar los matches dudosos;
- si la tabla no tiene las columnas, funciona igual pero sin control de reintentos
  (y lo dice en el log).

> Si usas la RPC `bulk_update_torrents`, vuelve a ejecutar `sql/002_bulk_update_rpc.sql`:
> la versión anterior no incluía las columnas `ids_*` y las habría ignorado en silencio.

### 3. Workflow

`.github/workflows/torrents-maintenance.yml` se ejecuta a diario (04:15 UTC) y bajo demanda.
Usa `concurrency` para evitar solapes y publica un resumen en la pestaña del job.

- **Cron diario:** por defecto ejecuta únicamente `dedupe` y aplica los borrados. Así no activa los
  filtros adulto/tamaño/torrents muertos sin que lo configures. Para que el cron simule, crea la
  variable de repositorio `DRY_RUN=true`.
- **Ejecución manual:** viene preseleccionada en `steps=dedupe` y es segura por defecto
  (`dry_run=true`). Revisa primero con `log_level=debug`; luego pon `dry_run=false` para aplicar sólo
  esos borrados. Si defines `STEPS` como variable del repositorio, el cron usa esa lista pero vuelve a
  simulación por seguridad, salvo que también pongas `DRY_RUN=false`.

Antes de la primera eliminación, revisa el log de una simulación con `steps=dedupe`, `dry_run=true` y
`log_level=debug`. Los borrados en Supabase son permanentes; comprueba los ejemplos de filas que marca.

### Ejecución local

```bash
npm ci
cp .env.example .env   # rellena credenciales; el script carga `.env` solo (sin pisar el entorno)
npm run dry-run                       # simula (no borra ni actualiza)
STEPS=dedupe DRY_RUN=true npm start   # previsualiza sólo los duplicados
STEPS=dedupe DRY_RUN=false npm start  # aplica sólo las eliminaciones de duplicados
npm run parse -- "[SubsPlease] Sousou no Frieren - 09 (1080p) [ABCDEF12].mkv"   # depurar el parser
npm test
```

## Configuración

Todas las opciones están documentadas en [`.env.example`](.env.example) y `src/config.js`. Las más relevantes:

| Variable | Defecto | Efecto |
|----------|---------|--------|
| `DRY_RUN` | `true` en local/manual; el cron sólo deduplica con escritura real por defecto | `true` simula; `false` aplica los cambios de los pasos elegidos |
| `STEPS` | `all` | Subconjunto de pasos (`adult,size,dead,normalize,enrich,dedupe`) |
| `MIN_MOVIE_MB` / `MIN_SERIES_MB` | `150` / `30` | Umbrales anti-fakes |
| `DEAD_AFTER_DAYS` | `30` | Antigüedad para purgar torrents con 0 seeders |
| `NORMALIZE_OVERWRITE_TYPE` | `false` | Sobrescribir `type` existente cuando el parser está seguro |
| `NORMALIZE_OVERWRITE_EPISODES` | `false` | Sobrescribir season/episode existentes |
| `ENRICH_MAX_LOOKUPS` | `300` | Obras resueltas vía API por ejecución (el resto, en la siguiente) |
| `DEDUP_OTHER_LANGUAGE_POLICY` | `delete` | `keep` para no tocar torrents en otros idiomas (francés, alemán…) |
| `DEDUP_UNKNOWN_LANGUAGE_AS` | `english` | Grupo para torrents sin información de idioma (`english`/`spanish`/`keep`) |
| `DEDUP_FALLBACK_TITLE_KEY` | `true` | Enlaza filas con/sin IDs si coinciden título normalizado, tipo y año; `false` desactiva ese fallback |
| `MAX_DELETE_RATIO` | `0.95` | Aborta un paso que quiera borrar más de ese % de filas evaluadas (no se aplica por debajo de 10 filas evaluadas: en tablas diminutas el porcentaje es ruido) |

## El parser de títulos

`src/parser/titleParser.js` es un motor RegEx tolerante a fallos. Soporta, entre otros:

- **Tipo**: `anime` (grupos `[SubsPlease]`, `[Erai-raws]`, `[Judas]`, `[PuyaSubs!]`… + CRC `[A1B2C3D4]`, kanji, `OVA`, partículas romaji), `series` (hay temporada/episodio), `movie`.
- **Episodios**: `S02E09`, `S2E9`, `S02E09-E10`, `T01E05` / `T1 EP5` (formato "temporada"), `Season 2 Episode 9`, `Temporada 2 Capítulo 9`, `2x09`, `1x01 al 1x10`, `Cap.209` (formato español), `Show 2 - 09`.
- **Absolutos (anime)**: `- 09`, `- 1085`, `[09]`, `Ep. 9` / `Ep.9` / `Cap. 5`, `Episode 87`, `第09話`, `#09`, `Naruto Shippuden 297`. Con `S04E28 - 87` guarda 28 como episodio y 87 como absoluto.
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

**Doblaje vs "sólo subtítulos"**: si el mejor candidato del grupo sólo tiene el idioma en los
subtítulos (un VOSE) y hay un doblaje a menos de 10 puntos (≈ media duplicación de seeders), se
conserva el doblaje. Fuera de ese margen mandan los seeders: un VOSE con muchos más seeders se ve,
y un doblaje con cuatro seeders puede que no.

Grupos de idioma: **spanish** = audio castellano/latino **o** subtítulos en español; **english** =
audio o subtítulos en inglés. Por cada película/episodio conserva **como máximo una fila española y
una inglesa**; un torrent dual puede cubrir ambos grupos (se conserva una sola fila).
Los torrents sin información de idioma se asignan al grupo `DEDUP_UNKNOWN_LANGUAGE_AS` (por defecto
`english`, que es lo habitual en releases sin etiquetar). Los que tienen audio y subtítulos
explícitos en otros idiomas se eliminan (`DEDUP_OTHER_LANGUAGE_POLICY=delete`) o se conservan.
Si en un grupo no queda ningún superviviente español/inglés, se conserva el mejor de todos modos:
dos copias en francés no se borran mutuamente (una sola copia tampoco se toca). Un pack
`S01E01-E10` no comparte clave con el episodio 1 suelto.

`DEDUP_FALLBACK_TITLE_KEY=true` (defecto) también agrupa filas sin IDs —e incluso una fila con ID
con otra sin ID— si coincide el tipo, el título normalizado y el año cuando el parser lo encuentra.
Sólo cruza el alias con IDs si hay un único grupo externo posible; ante títulos ambiguos conserva las
filas. Esto permite deduplicar aunque falten `imdb_id`/`tmdb_id`/IDs de anime. Se puede poner en
`false` para desactivar el fallback; `DRY_RUN` y `LOG_LEVEL=debug` permiten revisar antes de borrar.

**Cuando no se sabe el episodio, no se borra nada**: si el título no permite identificar el
episodio (`full` en la clave interna), dos releases de la misma obra no se consideran duplicados,
porque podrían ser dos episodios distintos. El resumen del paso lo indica:
`dedupe: 12 filas en 3 grupos sin episodio identificable se dejan intactas`. Un `COMPLETE` o un
pack de temporada explícitos sí se agrupan (ahí sí hay información suficiente).

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

## Desarrollo y comprobaciones

La integración continua ejecuta la suite offline en Node.js 22 y 24 para cada push y pull request,
y audita las dependencias de producción. Para reproducirlo localmente:

```bash
npm ci
npm test
npm audit --omit=dev
```

Los tests usan un cliente Supabase falso en memoria; no necesitan credenciales ni escriben en una
base de datos real.
