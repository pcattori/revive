import { defineConfig } from 'tsup'

export default defineConfig({
  format: ['esm'],
  entry: ['src/cli.ts', 'src/index.ts'],
  clean: true,
})
