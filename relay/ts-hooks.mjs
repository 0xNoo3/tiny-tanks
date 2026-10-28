/** Module hooks for ts-register.mjs: transform .ts sources with Node's built-in TypeScript support. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.ts') || !url.startsWith('file:')) return nextLoad(url, context)
  const source = await readFile(fileURLToPath(url), 'utf8')
  return {
    format: 'module',
    shortCircuit: true,
    source: stripTypeScriptTypes(source, { mode: 'transform', sourceMap: false }),
  }
}
