import * as path from 'node:path'
import { type RemixConfig, readConfig } from '@remix-run/dev/dist/config.js'
import { createRequestHandler } from '@remix-run/node'
import { type ServerBuild } from '@remix-run/server-runtime'
import { getRouteModuleExports } from '@remix-run/dev/dist/compiler/utils/routeExports.js'
import { type Plugin, normalizePath as viteNormalizePath } from 'vite'
import jsesc from 'jsesc'

import * as NodeAdapter from './node/adapter.js'
import * as VirtualModule from './vmod.js'
import { Manifest } from '@remix-run/dev/dist/manifest.js'

let serverEntry = VirtualModule.id('server-entry')
let serverManifest = VirtualModule.id('server-manifest')
let browserManifest = VirtualModule.id('browser-manifest')

const normalizePath = (p: string) => {
  let unixPath = p.replace(/[\\/]+/g, '/').replace(/^([a-zA-Z]+:|\.\/)/, '')
  return viteNormalizePath(unixPath)
}

const resolveFSPath = (filePath: string) => `/@fs${normalizePath(filePath)}`

type Route = RemixConfig['routes'][string]
const resolveRelativeRouteFilePath = (route: Route, config: RemixConfig) => {
  const file = route.file
  const fullPath = path.resolve(config.appDirectory, file)

  return normalizePath(fullPath)
}

const getServerEntry = (config: RemixConfig) => {
  return `
  import * as entryServer from ${JSON.stringify(
    resolveFSPath(path.resolve(config.appDirectory, config.entryServerFile))
  )};
  ${Object.keys(config.routes)
    .map((key, index) => {
      const route = config.routes[key]!
      return `import * as route${index} from ${JSON.stringify(
        resolveFSPath(resolveRelativeRouteFilePath(route, config))
      )};`
    })
    .join('\n')}
    export { default as assets } from ${JSON.stringify(serverManifest)};
    export const assetsBuildDirectory = ${JSON.stringify(
      config.relativeAssetsBuildDirectory
    )};
    ${
      config.future
        ? `export const future = ${JSON.stringify(config.future)}`
        : ''
    };
    export const publicPath = ${JSON.stringify(config.publicPath)};
    export const entry = { module: entryServer };
    export const routes = {
      ${Object.keys(config.routes)
        .map((key, index) => {
          const route = config.routes[key]!
          return `${JSON.stringify(key)}: {
        id: ${JSON.stringify(route.id)},
        parentId: ${JSON.stringify(route.parentId)},
        path: ${JSON.stringify(route.path)},
        index: ${JSON.stringify(route.index)},
        caseSensitive: ${JSON.stringify(route.caseSensitive)},
        module: route${index}
      }`
        })
        .join(',\n  ')}
    };`
}

let vmods = [serverEntry, serverManifest, browserManifest]

const getAssetManifest = async (config: RemixConfig): Promise<Manifest> => {
  const routes: Record<string, any> = {}

  for (const entry of Object.entries(config.routes)) {
    const [key, route] = entry
    const sourceExports = await getRouteModuleExports(config, route.id)

    routes[key] = {
      id: route.id,
      parentId: route.parentId,
      path: route.path,
      index: route.index,
      caseSensitive: route.caseSensitive,
      module: resolveFSPath(resolveRelativeRouteFilePath(route, config)),
      hasAction: sourceExports.includes('action'),
      hasLoader: sourceExports.includes('loader'),
      hasCatchBoundary: sourceExports.includes('CatchBoundary'),
      hasErrorBoundary: sourceExports.includes('ErrorBoundary'),
      imports: [],
    }
  }

  return {
    version: String(Math.random()),
    entry: {
      module: resolveFSPath(
        path.resolve(config.appDirectory, config.entryClientFile)
      ),
      imports: [],
    },
    routes,
  }
}

export let revive: () => Promise<Plugin[]> = async () => {
  let config = await readConfig()
  let manifest = await getAssetManifest(config)
  manifest.url = VirtualModule.url(browserManifest)

  return [
    {
      name: 'revive',
      config: () => ({ appType: 'custom' }),
      configureServer(vite) {
        return () => {
          vite.middlewares.use(async (req, res, next) => {
            try {
              let build = (await vite.ssrLoadModule(serverEntry)) as ServerBuild
              const handler = createRequestHandler(build, 'development')

              let request = NodeAdapter.createRequest(req)
              let response = await handler(request, {})
              NodeAdapter.handleNodeResponse(response, res)
            } catch (error) {
              next(error)
            }
          })
        }
      },
    },
    {
      name: 'revive-virtual-modules',
      enforce: 'pre',
      resolveId(id) {
        if (vmods.includes(id)) return VirtualModule.resolve(id)
      },
      load(id) {
        switch (id) {
          case VirtualModule.resolve(serverEntry):
            return getServerEntry(config)
          case VirtualModule.resolve(serverManifest):
            return `export default ${jsesc(manifest, { es6: true })};`
          case VirtualModule.resolve(browserManifest):
            return `window.__remixManifest=${jsesc(manifest, { es6: true })};`
        }
      },
    },
  ]
}
