import { writeFileSync } from 'node:fs'

const { partsDatabase } = await import(new URL('../parts-database.js', import.meta.url))
if (!partsDatabase || typeof partsDatabase !== 'object') {
  throw new Error('[build-parts-json] parts-database.js did not export partsDatabase')
}
writeFileSync(new URL('../parts-database.json', import.meta.url), `${JSON.stringify(partsDatabase, null, 1)}\n`)
console.log(`[build-parts-json] wrote ${Object.keys(partsDatabase).length} records`)
