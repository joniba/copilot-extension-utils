import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { observeOperation } from '../diagnostics/operation.mjs';

export async function runInstallerCli(argv, {
  name, version, install, doctor, write = line => console.log(line), diagnostics,
}) {
  return observeOperation('installer.cli', diagnostics, async () => {
    if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(name) || typeof version !== 'string' || !version.trim()
      || typeof install !== 'function' || typeof doctor !== 'function' || typeof write !== 'function') {
      throw new TypeError('Provide an installer name, version, install and doctor callbacks.');
    }
    const { values } = parseArgs({ args: argv, options: {
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
      doctor: { type: 'boolean' }, update: { type: 'boolean' }, 'copilot-home': { type: 'string' },
    } });
    const modes = ['help', 'version', 'doctor'].filter(mode => values[mode]);
    if (modes.length > 1 || (modes.length && values.update)) throw new TypeError('Conflicting installer flags.');
    if (values.help) return write(`Usage: ${name} [--update | --doctor | --version | --help] [--copilot-home PATH]`);
    if (values.version) return write(version);
    const copilotHome = values['copilot-home'] ?? process.env.COPILOT_HOME ?? join(homedir(), '.copilot');
    if (!isAbsolute(copilotHome)) throw new TypeError('Copilot home must be an absolute path.');
    const result = await (values.doctor ? doctor : install)({ copilotHome, update: !!values.update });
    if (values.doctor && result?.ok !== true) {
      throw Object.assign(new Error('Installed extension did not pass verification.'), { code: 'ERR_INSTALL_DOCTOR' });
    }
    return result;
  });
}
