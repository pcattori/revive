import { revive } from 'rev'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [await revive()],
})
