import { defineConfig } from 'vite'
import mdx from '@mdx-js/rollup'
import { revive, legacyRemixCssImportSemantics } from 'revive'

export default defineConfig({
  plugins: [revive(), legacyRemixCssImportSemantics(), mdx()],
})
