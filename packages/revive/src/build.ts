import * as vite from 'vite'

interface BuildOptions {
  configFile?: string
  force?: boolean
}

export async function build({ configFile, force }: BuildOptions) {
  async function viteBuild({ ssr }: { ssr: boolean }) {
    await vite.build({
      configFile,
      build: { ssr },
      optimizeDeps: { force },
    })
  }

  await viteBuild({ ssr: false })
  await viteBuild({ ssr: true })
}
