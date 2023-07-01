import * as path from 'node:path'
import { type RemixConfig, readConfig } from '@remix-run/dev/dist/config.js'
import { createRequestHandler } from '@remix-run/node'
import { type ServerBuild } from '@remix-run/server-runtime'
import { getRouteModuleExports } from '@remix-run/dev/dist/compiler/utils/routeExports.js'
import { type Plugin, normalizePath as viteNormalizePath } from 'vite'
import jsesc from 'jsesc'

import * as adapter from './node/adapter.js'
import * as VirtualModule from './vmod.js'

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
    export { default as assets } from ${JSON.stringify(
      'virtual:server-assets-manifest'
    )};
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

const getRemixRouteModuleExports = async (routeId: string) => {
  const config = await readConfig()
  return getRouteModuleExports(config, routeId)
}

const getAssetManifest = async (config: RemixConfig) => {
  const routes: Record<string, any> = {}

  for (const entry of Object.entries(config.routes)) {
    const [key, route] = entry
    const sourceExports = await getRemixRouteModuleExports(route.id)

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
    version: Math.random(),
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

  let serverEntryJs = getServerEntry(config)
  let serverEntryVMod = VirtualModule.create('server-entry', serverEntryJs)

  let serverManifestVMod = VirtualModule.create(
    'server-assets-manifest',
    `export default ${jsesc(manifest, { es6: true })};`
  )
  const browserManifestVMod = VirtualModule.create(
    'browser-assets-manifest',
    `window.__remixManifest=${jsesc(manifest, { es6: true })};`
  )
  // manifest.url = VMod.url(browserManifestVMod)

  const virtualModules = [
    serverEntryVMod,
    serverManifestVMod,
    browserManifestVMod,
  ]

  return [
    {
      name: 'revive',
      config: () => ({ appType: 'custom' }),
      configureServer(vite) {
        return () => {
          vite.middlewares.use(async (req, res, next) => {
            try {
              let build = (await vite.ssrLoadModule(
                serverEntryVMod.id
              )) as ServerBuild

              const handler = createRequestHandler(build, 'development')

              // adapter
              let request = adapter.createRequest(req)
              let response = await handler(request, {})

              adapter.handleNodeResponse(response, res)
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
        for (const vmod of virtualModules) {
          console.log(`resolve: ${id} ${vmod}`)
          if (id === vmod.id) {
            return VirtualModule.resolve(vmod)
          }
        }
      },
      load(id) {
        for (const vmod of virtualModules) {
          console.log(`load: ${id} ${VirtualModule.resolve(vmod)}`)
          if (id === VirtualModule.resolve(vmod)) {
            return vmod.code
          }
        }
      },
    },
  ]
}
