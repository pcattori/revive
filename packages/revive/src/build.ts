import * as vite from 'vite'

export async function build() {
  await vite.build()
  await vite.build({ build: { ssr: true } })
}
