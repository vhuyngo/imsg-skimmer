#!/usr/bin/env node
// node:sqlite prints an ExperimentalWarning on load; hide only that one.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  if (type === 'ExperimentalWarning' && String(warning?.message ?? warning).includes('SQLite')) return;
  return emitWarning.call(process, warning, ...rest);
};

const { main } = await import('../src/cli.js');
process.exitCode = await main(process.argv.slice(2));
