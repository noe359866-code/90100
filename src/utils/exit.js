/**
 * Salida ordenada del proceso.
 *
 * `supabase-js`/undici dejan sockets abiertos, así que el script tiene que llamar
 * a `process.exit()` para que el job de GitHub Actions no se quede colgado. Pero
 * `process.exit()` NO espera a las escrituras pendientes y, como en Actions
 * stdout es un pipe (buffer de 64 KB), el final del log —justo el resumen del
 * mantenimiento— se perdía truncado.
 *
 * Solución: encolar una escritura vacía (su callback se ejecuta cuando ya se han
 * vaciado las anteriores) y salir después.
 */

const waitFor = (stream) => new Promise((resolve) => {
  if (!stream || stream.destroyed) return resolve();
  try {
    stream.write('', () => resolve());
  } catch {
    resolve(); // EPIPE / stream cerrado: no hay nada que vaciar
  }
});

/** Espera a que stdout y stderr se hayan vaciado. Nunca rechaza. */
export function flushOutput() {
  return Promise.all([waitFor(process.stdout), waitFor(process.stderr)]);
}

/**
 * Vacía stdout/stderr y llama a `process.exit(code)`.
 * Si el vaciado se atascara, un temporizador (sin unref para que no mantenga
 * vivo el proceso por sí solo) fuerza la salida pasado `maxWaitMs`.
 */
export function exitSoon(code, { maxWaitMs = 5000 } = {}) {
  const guard = setTimeout(() => process.exit(code), maxWaitMs);
  guard.unref?.();
  flushOutput().then(() => process.exit(code), () => process.exit(code));
  return guard;
}
