import { readConfig } from '@remix-run/dev/dist/config.js'
import path from 'node:path'
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
}
