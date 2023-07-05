import { LinksFunction, json } from '@remix-run/node'
import { useLoaderData } from '@remix-run/react'

import styles from './styles.css?url'
import doggo from './doggo.jpg'

export const links: LinksFunction = () => {
  return [{ rel: 'stylesheet', href: styles }]
}

export const loader = () => {
  return json({ message: 'hello from loader!' })
}

export default () => {
  const { message } = useLoaderData<typeof loader>()
  return (
    <div>
      <h1 className="blah_heading">{message}</h1>
      <img src={doggo} width="460" height="460" alt="Doggo" />
    </div>
  )
}
