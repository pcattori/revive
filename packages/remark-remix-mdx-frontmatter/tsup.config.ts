import { defineConfig } from 'tsup'

export default defineConfig((options) => ({
  format: ['esm'],
  entry: ['src/index.ts'],
  clean: true,
  dts: !options.watch, // Enabling this in watch mode crashes the build when saving files, not sure why
}))
