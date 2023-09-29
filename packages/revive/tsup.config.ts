import fs from 'node:fs/promises'

import { defineConfig } from 'tsup'

export default defineConfig((options) => ({
  format: ['esm'],
  entry: ['src/cli.ts', 'src/index.ts'],
  clean: true,
  dts: !options.watch, // Enabling this in watch mode crashes the build when saving files, not sure why
  onSuccess: async () => {
    await fs.copyFile('./src/refresh-utils.cjs', './dist/refresh-utils.cjs')
  },
}))
