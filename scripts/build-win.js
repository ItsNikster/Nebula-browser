const path = require('path');
const { packager } = require('@electron/packager');

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const outputDir = path.join(projectRoot, 'release');

  await packager({
    dir: projectRoot,
    name: 'Nebula',
    executableName: 'Nebula',
    out: outputDir,
    platform: 'win32',
    arch: 'x64',
    overwrite: true,
    asar: true,
    prune: true,
    ignore: [
      /[\\/]release($|[\\/])/,
      /smoke\.(stdout|stderr)\.log$/,
      /[\\/]node_modules[\\/]\.cache($|[\\/])/
    ]
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
