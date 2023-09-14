import { defineConfig } from 'vite'

import { revive, legacyRemixCssImportSemantics } from 'revive'

export default defineConfig({
  plugins: [revive(), legacyRemixCssImportSemantics()],
})
