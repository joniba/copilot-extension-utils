import { defineSlashCommand } from './lib/commands/slash.mjs';

export function greetingCommand(getSession) {
  return defineSlashCommand({
    name: 'utils-greet',
    description: 'Display a local greeting.',
    getSession,
    usage: 'Usage: /utils-greet hello',
    parse: args => args === 'hello' ? args : null,
    execute: (_, { session }) => session.log('Hello from the sample extension.', { level: 'info' }),
  });
}
