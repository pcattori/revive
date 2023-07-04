import { readFile } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import { type RemixConfig } from '@remix-run/dev/dist/config.js'
import { type Manifest as ViteManifest } from 'vite'

export const getViteManifest = async (
  config: RemixConfig
): Promise<ViteManifest> => {
  const manifestContents = await readFile(
    resolvePath(config.assetsBuildDirectory, 'manifest.json'),
    'utf-8'
  )
  return JSON.parse(manifestContents) as ViteManifest
}
