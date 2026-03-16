/**
 * One-off script to generate PNG icons from folio-icon.svg.
 * Run: node scripts/gen-icons.mjs
 * Requires: npm install --save-dev sharp
 */
import sharp from 'sharp'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const svgPath = resolve(__dirname, '../public/folio-icon.svg')
const svgBuffer = readFileSync(svgPath)

const sizes = [192, 512]

for (const size of sizes) {
  const outPath = resolve(__dirname, `../public/folio-icon-${size}.png`)
  await sharp(svgBuffer)
    .resize(size, size)
    .png()
    .toFile(outPath)
  console.log(`Generated ${outPath}`)
}

console.log('Done.')
