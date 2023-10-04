#!/usr/bin/env node
import { Command } from 'commander'

import { build } from './build.js'
import { dev } from './dev.js'

let program = new Command()
program.name('revive')

program
  .command('build')
  .description('Build for production')
  .option('-c, --config <file>', 'Specify Vite config file')
  .option(
    '--force',
    'Force the optimizer to ignore the cache and re-bundle',
    false
  )
  .action(async ({ config: configFile, force }) => {
    await build({ configFile, force })
  })

program
  .command('dev')
  .description('Start dev server')
  .option('-c, --config <file>', 'Specify Vite config file')
  .option('-p, --port <number>', 'Specify port number')
  .option('--strictPort', 'Exit if specified port is already in use')
  .option('--host [host]', 'Specify hostname')
  .option(
    '--force',
    'Force the optimizer to ignore the cache and re-bundle',
    false
  )
  .action(({ config, port, strictPort, host, force }) => {
    dev({ config, port, strictPort, host, force })
  })

program.parse()
