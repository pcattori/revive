import { readConfig } from '@remix-run/dev/dist/config.js'
import path from 'node:path'
import fs from 'node:fs/promises'
import * as vite from 'vite'

export async function build() {
  const config = await readConfig()

  await vite.build({
    build: {
      ssrManifest: true,
      manifest: true,
      outDir: config.assetsBuildDirectory,
      rollupOptions: {
        preserveEntrySignatures: 'exports-only',
        input: [
          path.resolve(config.appDirectory, config.entryClientFile),
          ...Object.values(config.routes).map((route) =>
            path.resolve(config.appDirectory, route.file)
          ),
        ],
        output: {
          manualChunks: undefined,
        },
      },
    },
  })

  const manifest = JSON.parse(
    await fs.readFile(
      path.resolve(config.assetsBuildDirectory, 'manifest.json'),
      'utf-8'
    )
  )
  const ssrManifest = JSON.parse(
    await fs.readFile(
      path.resolve(config.assetsBuildDirectory, 'ssr-manifest.json'),
      'utf-8'
    )
  )

  await vite.build({
    build: {
      ssr: true,
      outDir: path.dirname(config.serverBuildPath),
      rollupOptions: {
        preserveEntrySignatures: 'exports-only',
        input: 'virtual:server-entry',
        output: {
          manualChunks: undefined,
        },
      },
    },
  })
}
