import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from '@remix-run/react'

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <h1>outlet begin</h1>
        <Outlet />
        <h1>outlet end</h1>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  )
}
