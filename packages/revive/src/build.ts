import { readConfig } from '@remix-run/dev/dist/config.js'
import path from 'node:path'
import * as vite from 'vite'

import { serverEntryId, getAssetManifestForBuild } from './plugin.js'
import { getViteManifest } from './getViteManifest.js'
import { writeFileSafe } from './writeFileSafe.js'

export async function build() {
  const config = await readConfig()

  await vite.build({
    base: config.publicPath,
    build: {
      manifest: true,
      outDir: config.assetsBuildDirectory,
      assetsDir: '.',
      rollupOptions: {
        preserveEntrySignatures: 'exports-only',
        input: [
          path.resolve(config.appDirectory, config.entryClientFile),
          ...Object.values(config.routes).map((route) =>
            path.resolve(config.appDirectory, route.file)
          ),
        ],
        output: {
          assetFileNames: '_assets/[name]-[hash][extname]',
        },
      },
    },
  })

  const viteManifest = await getViteManifest(config)
  const remixManifest = await getAssetManifestForBuild(config, viteManifest)

  const filename = `manifest-${remixManifest.version}.js`
  remixManifest.url = `${config.publicPath}${filename}`
  const manifestJson = JSON.stringify(remixManifest)
  await writeFileSafe(
    path.join(config.assetsBuildDirectory, filename),
    `window.__remixManifest=${manifestJson};`
  )

  process.env.__REMIX_BUILD_MANIFEST_JSON__ = manifestJson

  await vite.build({
    base: config.publicPath,
    build: {
      ssr: true,
      outDir: path.dirname(config.serverBuildPath),
      assetsDir: '.',
      rollupOptions: {
        preserveEntrySignatures: 'exports-only',
        input: serverEntryId,
        output: {
          entryFileNames: path.basename(config.serverBuildPath),
          assetFileNames: '_assets/[name]-[hash][extname]',
          format: 'cjs',
        },
      },
    },
  })
}
