// Generates parts-database.json from parts-database.js at build time.
// The .js file stays the single source of truth (tests + offline fallback
// import it synchronously); the .json is what production fetches with
// no-store so part updates reach devices without SW-cache staleness.
//
// Run: node scripts/build-parts-json.mjs  (invoked from npm run build)
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const jsFile = join(root, 'parts-database.js')
const jsonFile = join(root, 'parts-database.json')

// Dynamic-import the module in a child process (avoids polluting this one)
// and dump the object as pretty JSON.
const script = `
  import { writeFileSync } from 'node:fs'
  const { partsDatabase } = await import(${JSON.stringify('file://' + jsFile)})
  writeFileSync(${JSON.stringify(jsonFile)}, JSON.stringify(partsDatabase, null, 1))
  console.log('[build-parts-json] keys:', Object.keys(partsDatabase).length)
`
execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' })
