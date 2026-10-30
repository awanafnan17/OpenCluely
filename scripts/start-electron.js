const { spawn } = require('child_process');
const path = require('path');

const electron = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [path.resolve(__dirname, '..'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env
});

child.on('error', (error) => {
  console.error(`Could not start Electron: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  process.exitCode = code === null ? (signal ? 1 : 0) : code;
});
