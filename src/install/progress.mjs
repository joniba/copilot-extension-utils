const labels = Object.freeze({
  preflight: 'Checking prerequisites',
  prepare: 'Preparing files and backups',
  activate: 'Activating extension',
  verify: 'Verifying installed files',
  receipt: 'Recording installed version',
  complete: 'Installation complete',
});

export function createInstallProgress({ write = line => console.log(line) } = {}) {
  if (typeof write !== 'function') throw new TypeError('Progress destination must be a function.');
  return ({ stage }) => {
    if (!Object.hasOwn(labels, stage)) throw new TypeError('Unknown installation stage.');
    return write(labels[stage]);
  };
}
