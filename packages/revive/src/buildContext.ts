import { Manifest } from '@remix-run/dev/dist/manifest.js'

interface BuildContext {
  manifest: Manifest
}

let buildContext: BuildContext | null = null

export const setBuildContext = (_buildContext: BuildContext) => {
  buildContext = _buildContext
}

export const getBuildContext = (): BuildContext => {
  if (!buildContext) {
    throw new Error('Build context not found')
  }

  return buildContext
}
