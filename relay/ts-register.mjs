/**
 * Lets plain `node` run the project's TypeScript sources, whatever the Node
 * version: a module hook converts each .ts file on load with Node's own
 * stripTypeScriptTypes() in "transform" mode (which also handles constructor
 * parameter properties and enums, unlike bare type stripping).
 *
 *   node --import ./relay/ts-register.mjs relay/authority.mjs
 *
 * Needs Node 22.13 or newer. start.mjs adds this automatically.
 */
import { register } from 'node:module'

register('./ts-hooks.mjs', import.meta.url)
