import { readConfig } from '@remix-run/dev/dist/config.js'
import path from 'node:path'
import fs from 'node:fs/promises'
import * as vite from 'vite'

import { serverEntryId, getBuildManifest } from './plugin.js'
import { setBuildContext } from './buildContext.js'

async function writeFileSafe(file: string, contents: string): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, contents)
  return file
}

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

  const viteManifest = JSON.parse(
    await fs.readFile(
      path.resolve(config.assetsBuildDirectory, 'manifest.json'),
      'utf-8'
    )
  ) as vite.Manifest
  const manifest = await getBuildManifest(config, viteManifest)

  const manifestFilename = `manifest-${manifest.version}.js`
  manifest.url = `${config.publicPath}${manifestFilename}`
  await writeFileSafe(
    path.join(config.assetsBuildDirectory, manifestFilename),
    `window.__remixManifest=${JSON.stringify(manifest)};`
  )

  setBuildContext({ manifest })

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
