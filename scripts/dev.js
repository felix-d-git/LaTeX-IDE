// npm run dev: esbuild watch + Server, auch unter Windows (dort gibt es kein `&`).
const { spawn } = require('child_process');
const kids = [
  spawn(process.execPath, ['build.js', '--watch'], { stdio: 'inherit' }),
  spawn(process.execPath, ['server/index.js'], { stdio: 'inherit' }),
];
const stop = () => kids.forEach((k) => k.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
kids.forEach((k) => k.on('exit', stop));
