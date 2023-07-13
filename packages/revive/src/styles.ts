import * as path from 'node:path'
import { RemixConfig } from '@remix-run/dev/dist/config.js'
import { ServerBuild } from '@remix-run/server-runtime'
import { matchRoutes } from '@remix-run/router'
import { ModuleNode, ViteDevServer } from 'vite'

type ServerRouteManifest = ServerBuild['routes']
type ServerRoute = ServerRouteManifest[string]

// Style collection logic adapted from solid-start: https://github.com/solidjs/solid-start

// Vite doesn't expose this so we just copy the list for now
// https://github.com/vitejs/vite/blob/3edd1af56e980aef56641a5a51cf2932bb580d41/packages/vite/src/node/plugins/css.ts#L96
const style_pattern = /\.(css|less|sass|scss|styl|stylus|pcss|postcss)$/
const module_style_pattern =
  /\.module\.(css|less|sass|scss|styl|stylus|pcss|postcss)$/

const getStylesForFiles = async (
  viteServer: ViteDevServer,
  files: string[]
): Promise<string | undefined> => {
  const styles: Record<string, string> = {}
  const deps = new Set<ModuleNode>()

  try {
    for (const file of files) {
      const normalizedPath = path.resolve(file).replace(/\\/g, '/')
      let node = await viteServer.moduleGraph.getModuleById(normalizedPath)
      if (!node) {
        const absolutePath = path.resolve(file)
        await viteServer.ssrLoadModule(absolutePath)
        node = await viteServer.moduleGraph.getModuleByUrl(absolutePath)

        if (!node) {
          console.log(`Could not resolve module for file: ${file}`)
          continue
        }
      }

      await findDeps(viteServer, node, deps)
    }
  } catch (e) {
    console.error(e)
  }

  for (const dep of deps) {
    if (
      dep.file &&
      style_pattern.test(dep.file) &&
      !dep.url.endsWith('?url') // Ignore styles that resolved as URLs, otherwise we'll end up injecting URLs into the style tag contents
    ) {
      try {
        const mod = await viteServer.ssrLoadModule(dep.url)
        if (module_style_pattern.test(dep.file)) {
          throw new Error('CSS Modules support not yet implemented')
        } else {
          styles[dep.url] = mod.default
        }
      } catch {
        console.warn(`Could not load ${dep.file}`)
        // this can happen with dynamically imported modules, I think
        // because the Vite module graph doesn't distinguish between
        // static and dynamic imports? TODO investigate, submit fix
      }
    }
  }

  return Object.values(styles).join('\n') || undefined
}

const findDeps = async (
  vite: ViteDevServer,
  node: ModuleNode,
  deps: Set<ModuleNode>
) => {
  // since `ssrTransformResult.deps` contains URLs instead of `ModuleNode`s, this process is asynchronous.
  // instead of using `await`, we resolve all branches in parallel.
  const branches: Promise<void>[] = []

  async function addFromNode(node: ModuleNode) {
    if (!deps.has(node)) {
      deps.add(node)
      await findDeps(vite, node, deps)
    }
  }

  async function addFromUrl(url: string) {
    const node = await vite.moduleGraph.getModuleByUrl(url)

    if (node) {
      await addFromNode(node)
    }
  }

  if (node.ssrTransformResult) {
    if (node.ssrTransformResult.deps) {
      node.ssrTransformResult.deps.forEach((url) =>
        branches.push(addFromUrl(url))
      )
    }
  } else {
    node.importedModules.forEach((node) => branches.push(addFromNode(node)))
  }

  await Promise.all(branches)
}

const groupRoutesByParentId = (manifest: ServerRouteManifest) => {
  let routes: Record<string, Omit<ServerRoute, 'children'>[]> = {}

  Object.values(manifest).forEach((route) => {
    let parentId = route.parentId || ''
    if (!routes[parentId]) {
      routes[parentId] = []
    }
    routes[parentId].push(route)
  })

  return routes
}

// Create a map of routes by parentId to use recursively instead of
// repeatedly filtering the manifest.
const createRoutes = (
  manifest: ServerRouteManifest,
  parentId: string = '',
  routesByParentId: Record<
    string,
    Omit<ServerRoute, 'children'>[]
  > = groupRoutesByParentId(manifest)
): ServerRoute[] => {
  return (routesByParentId[parentId] || []).map((route) => ({
    ...route,
    children: createRoutes(manifest, route.id, routesByParentId),
  }))
}

const routeFilesForUrl = (
  config: RemixConfig,
  build: ServerBuild,
  requestUrl: string
) => {
  const routes = createRoutes(build.routes)
  const appPath = path.relative(process.cwd(), config.appDirectory)
  return (
    matchRoutes(routes, requestUrl)?.map((match) =>
      path.join(appPath, config.routes[match.route.id].file)
    ) ?? []
  )
}

export const getStylesForUrl = async (
  vite: ViteDevServer,
  config: RemixConfig,
  build: ServerBuild,
  url: string | undefined
): Promise<string | undefined> => {
  if (url === undefined || url.includes('?_data=')) {
    return undefined
  }

  const documentRouteFiles = routeFilesForUrl(config, build, url)
  const styles = await getStylesForFiles(vite, documentRouteFiles)

  return styles
}
