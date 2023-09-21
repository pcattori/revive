import * as path from 'node:path'
import { RemixConfig } from '@remix-run/dev/dist/config.js'
import { ViteDevServer, normalizePath as viteNormalizePath } from 'vite'

const normalizePath = (p: string) => {
  let unixPath = p.replace(/[\\/]+/g, '/').replace(/^([a-zA-Z]+:|\.\/)/, '')
  return viteNormalizePath(unixPath)
}

export const resolveFsUrl = (filePath: string) =>
  `/@fs${normalizePath(filePath)}`

type Route = RemixConfig['routes'][string]
export const resolveRelativeRouteFilePath = (
  route: Route,
  config: RemixConfig
) => {
  const file = route.file
  const fullPath = path.resolve(config.appDirectory, file)

  return normalizePath(fullPath)
}

export const getRouteModuleExports = async (
  viteChildCompiler: ViteDevServer | null,
  config: RemixConfig,
  routeFile: string
): Promise<string[]> => {
  if (!viteChildCompiler) {
    throw new Error('Vite child compiler not found')
  }

  const routePath = path.join(config.appDirectory, routeFile)

  // Get the compiled route module code from the Vite child compiler so that we
  // can parse the exports from non-JS files like MDX. This ensures that we can
  // understand the exports from anything that Vite can compile to JS, not just
  // the route file formats that the Remix compiler historically supported.
  const compiledRouteModuleCode = (
    await viteChildCompiler.transformRequest(resolveFsUrl(routePath), {
      ssr: true,
    })
  )?.code

  if (!compiledRouteModuleCode) {
    throw new Error(`No route module code found for ${routePath}`)
  }

  // Match `Object.defineProperty(__vite_ssr_exports__, "loader", ...)`
  const exportsDefinePropertyMatches =
    compiledRouteModuleCode.match(
      /(?<=Object\.defineProperty\(__vite_ssr_exports__,\s*['"])(\w+)(?=['"])/g
    ) ?? []

  // Match `__vite_ssr_exports__.default = ...`
  const exportsAssignmentMatches =
    compiledRouteModuleCode.match(
      /(?<=__vite_ssr_exports__\.)(\w+)(?=\s*=\s*[^=])/g
    ) ?? []

  const routeModuleExports = [
    ...exportsDefinePropertyMatches,
    ...exportsAssignmentMatches,
  ]

  return routeModuleExports
}
