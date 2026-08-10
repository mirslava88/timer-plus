import sharp from 'sharp'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await sharp(resolve(root, 'resources/icon.svg'))
  .resize(1024, 1024)
  .png()
  .toFile(resolve(root, 'resources/icon.png'))

console.log('Generated resources/icon.png')
