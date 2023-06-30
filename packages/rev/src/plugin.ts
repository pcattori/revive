import { Plugin } from 'vite'

export let revive: Plugin = {
  name: 'revive',
  configureServer(vite) {
    return () => {
      vite.middlewares.use(async (req, res, next) => {
        let build = await vite.ssrLoadModule(`virtual:remix-server`)
        console.log({ build })

        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ hello: 'world' }))
      })
    }
  },
}
