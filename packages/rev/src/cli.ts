import { Command } from 'commander'

let program = new Command()
program.name('rev')

program.command('build').action(() => {
  console.log('build!')
})

program.command('serve').action(() => {
  console.log('serve!')
})

program.command('dev').action(() => {
  console.log('dev!')
})

program.parse()
