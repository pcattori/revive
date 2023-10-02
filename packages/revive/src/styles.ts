import * as path from 'node:path'
import { RemixConfig as ResolvedRemixConfig } from '@remix-run/dev/dist/config.js'
import { ServerBuild } from '@remix-run/server-runtime'
import { matchRoutes } from '@remix-run/router'
import { ModuleNode, ViteDevServer } from 'vite'

type ServerRouteManifest = ServerBuild['routes']
type ServerRoute = ServerRouteManifest[string]

// Style collection logic adapted from solid-start: https://github.com/solidjs/solid-start

// Vite doesn't expose these so we just copy the list for now
// https://github.com/vitejs/vite/blob/d6bde8b03d433778aaed62afc2be0630c8131908/packages/vite/src/node/constants.ts#L49C23-L50
const cssFileRegExp =
  /\.(css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/
// https://github.com/vitejs/vite/blob/d6bde8b03d433778aaed62afc2be0630c8131908/packages/vite/src/node/plugins/css.ts#L160
const cssModulesRegExp = new RegExp(`\\.module${cssFileRegExp.source}`)

const isCssFile = (file: string) => cssFileRegExp.test(file)
export const isCssModulesFile = (file: string) => cssModulesRegExp.test(file)

const getStylesForFiles = async (
  viteServer: ViteDevServer,
  cssModulesManifest: Record<string, string>,
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
      isCssFile(dep.file) &&
      !dep.url.endsWith('?url') // Ignore styles that resolved as URLs, otherwise we'll end up injecting URLs into the style tag contents
    ) {
      try {
        const css = isCssModulesFile(dep.file)
          ? cssModulesManifest[dep.file]
          : (await viteServer.ssrLoadModule(dep.url)).default

        if (css === undefined) {
          throw new Error()
        }

        styles[dep.url] = css
      } catch {
        console.warn(`Could not load ${dep.file}`)
        // this can happen with dynamically imported modules, I think
        // because the Vite module graph doesn't distinguish between
        // static and dynamic imports? TODO investigate, submit fix
      }
    }
  }

  return (
    Object.entries(styles)
      .map(([fileName, css], i) => [
        `\n/* ${fileName
          // Escape comment syntax in file paths
          .replace(/\/\*/g, '/\\*')
          .replace(/\*\//g, '*\\/')} */`,
        css,
      ])
      .flat()
      .join('\n') || undefined
  )
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

export const getStylesForUrl = async (
  vite: ViteDevServer,
  config: Pick<ResolvedRemixConfig, 'appDirectory' | 'routes'>,
  cssModulesManifest: Record<string, string>,
  build: ServerBuild,
  url: string | undefined
): Promise<string | undefined> => {
  if (url === undefined || url.includes('?_data=')) {
    return undefined
  }

  const routes = createRoutes(build.routes)
  const appPath = path.relative(process.cwd(), config.appDirectory)
  const documentRouteFiles =
    matchRoutes(routes, url)?.map((match) =>
      path.join(appPath, config.routes[match.route.id].file)
    ) ?? []

  const styles = await getStylesForFiles(
    vite,
    cssModulesManifest,
    documentRouteFiles
  )

  return styles
}
