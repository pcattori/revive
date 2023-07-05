import { readConfig } from '@remix-run/dev/dist/config.js'
import path from 'node:path'
import * as vite from 'vite'

import { serverEntryId } from './plugin.js'

export async function build() {
  const config = await readConfig()

  await vite.build({
    base: config.publicPath,
    build: {
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
      },
    },
  })

  await vite.build({
    base: config.publicPath,
    build: {
      ssr: true,
      outDir: path.dirname(config.serverBuildPath),
      rollupOptions: {
        preserveEntrySignatures: 'exports-only',
        input: serverEntryId,
        output: {
          entryFileNames: path.basename(config.serverBuildPath),
          format: 'cjs',
        },
      },
    },
  })
}
