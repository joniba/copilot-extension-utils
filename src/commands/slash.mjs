import { observeOperation } from '../diagnostics/operation.mjs';

export function defineSlashCommand({
  name, description, getSession, usage, parse, execute, menu, diagnostics,
}) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(name)
    || typeof usage !== 'string' || !usage.trim()
    || [getSession, parse, execute].some(value => typeof value !== 'function')
    || (menu !== undefined && typeof menu !== 'function')) throw new TypeError('Invalid slash command definition.');

  return {
    name, description,
    async handler(context) {
      return observeOperation('command.invoke', diagnostics, async trace => {
        const session = getSession();
        if (typeof session?.sessionId !== 'string' || !session.sessionId) {
          throw Object.assign(new Error('The extension is not attached yet.'), { code: 'ERR_COMMAND_NOT_READY' });
        }
        if (context?.sessionId !== session.sessionId) {
          throw Object.assign(new Error('The command belongs to another session.'), { code: 'ERR_COMMAND_OWNER' });
        }
        if (typeof context.args !== 'string') throw new TypeError('Expected raw command arguments.');
        let args = context.args.trim();
        const showUsage = () => session.log(usage, { level: 'info' });
        if (['help', '--help', '-h'].includes(args)) {
          await showUsage();
          return;
        }
        if (!args) {
          if (!menu || session.capabilities?.ui?.elicitation !== true || !session.ui) {
            await showUsage();
            return;
          }
          args = await menu(session);
          if (args === null) {
            trace('cancelled');
            return;
          }
          if (typeof args !== 'string' || !args.trim()) throw new TypeError('Menu must return arguments or null.');
        }
        const input = await parse(args);
        if (input === null) {
          await showUsage();
          return;
        }
        await execute(input, { session, context });
      });
    },
  };
}
