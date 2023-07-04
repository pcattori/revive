import { spawn } from 'child_process'

import { Command } from 'commander'

import { build } from './build.js'

let program = new Command()
program.name('rev')

program.command('build').action(build)

program.command('serve').action(() => {
  console.log('serve!')
})

program.command('dev').action(() => {
  spawn('vite', ['dev'], {
    shell: true,
    stdio: 'inherit',
    env: {
      ...process.env,
    },
  })
})

program.parse()
