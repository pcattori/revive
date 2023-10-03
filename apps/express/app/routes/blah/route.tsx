import { json } from '@remix-run/node'
import { useLoaderData } from '@remix-run/react'

import './styles.css'
import styles from './styles.module.css'
import doggo from './doggo.jpg'
import { value1, value2 } from './loader-util-1'
import { Component } from './component'

export const loader = () => {
  return json({ message: 'hello from loader!', val1: value1, val2: value2 })
}

// React components must be named functions for React Fast Refresh to work
// named arrow functions are fine too, but not anonymous functions
export default function Blah() {
  const { message, val1, val2 } = useLoaderData<typeof loader>()
  return (
    <div>
      <h1 className="blah_heading">{message}</h1>
      {/* <h2>{val1}</h2> */}
      <h2>{val2}</h2>
      <Component val={val1} />
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
