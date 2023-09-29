import { json } from '@remix-run/node'
import { useLoaderData } from '@remix-run/react'

import './styles.css'
import styles from './styles.module.css'
import doggo from './doggo.jpg'

export const loader = () => {
  return json({ message: 'hello from loader!' })
}

// React components must be named functions for React Fast Refresh to work
// named arrow functions are fine too, but not anonymous functions
export default function Blah() {
  const { message } = useLoaderData<typeof loader>()
  return (
    <div>
      <h1 className="blah_heading">{message}</h1>
      <img
        src={doggo}
        className={styles.image}
        width="460"
        height="460"
        alt="Doggo"
      />
    </div>
  )
}
