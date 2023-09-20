import { defineConfig } from 'vite'

import { revive, legacyRemixCssImportSemantics } from 'revive'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [revive(), legacyRemixCssImportSemantics(), react()],
})
