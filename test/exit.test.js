/**
 * `exitSoon`: forzar la salida sin perder el log.
 *
 * En GitHub Actions stdout es un pipe (64 KB de buffer): llamar a `process.exit()`
 * directamente truncaba el resumen final del mantenimiento.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const exitModule = fileURLToPath(new URL('../src/utils/exit.js', import.meta.url));
const BYTES = 200_000; // bastante más que el buffer del pipe

function runChild(source) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('exitSoon: no trunca lo escrito antes de salir', async () => {
  const { code, stdout } = await runChild(`
    import { exitSoon } from ${JSON.stringify(exitModule)};
    process.stdout.write('x'.repeat(${BYTES}));
    exitSoon(0);
  `);
  assert.equal(code, 0);
  assert.equal(stdout.length, BYTES, 'todo el log debe llegar al proceso padre');
});

test('exitSoon: conserva el código de salida', async () => {
  const { code } = await runChild(`
    import { exitSoon } from ${JSON.stringify(exitModule)};
    exitSoon(3);
  `);
  assert.equal(code, 3);
});

test('flushOutput: nunca rechaza aunque la salida esté cerrada', async () => {
  const { flushOutput } = await import('../src/utils/exit.js');
  await assert.doesNotReject(() => flushOutput());
});
