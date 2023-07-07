import { defineConfig } from 'vite'

import { revive } from 'revive'

export default defineConfig({
  plugins: [revive()],
})
