// Official release pins, checked 2026-09-07. Hashes are not signature verification.
const MAX_BYTES = 100 * 1024 * 1024;
export const ARTIFACTS = Object.freeze({
  cli: Object.freeze({
    directory: 'lark-cli-1.0.93-windows-amd64', name: 'lark-cli.exe', version: '1.0.93',
    url: 'https://github.com/larksuite/cli/releases/download/v1.0.93/lark-cli-1.0.93-windows-amd64.zip',
    sha256: '18e9320e378a0eefdb3b7004e0c6d42f48da85ae196d2bf5e89e4299ae7674d7',
    member: 'lark-cli.exe',
    executableSha256: '39ba320129d7c700f907d0ea0d4a79467262a72ca0f971879f5f45cf5f782645',
    maxBytes: MAX_BYTES,
    license: Object.freeze({
      url: 'https://raw.githubusercontent.com/larksuite/cli/v1.0.93/LICENSE',
      sha256: 'c969fc7e3af68e6bf40b0d8dd9c3dcc377eb685a2139535b203b39fdcad739ee',
      maxBytes: 1024 * 1024,
    }),
  }),
  node: Object.freeze({
    directory: 'node-24.15.0-win-x64', name: 'node.exe', version: '24.15.0',
    url: 'https://nodejs.org/dist/v24.15.0/win-x64/node.exe',
    sha256: '3331e1ffe19874215472217c5e94f5a0c6d8e18c4ac7111d3937aa0ad5e9b4a5',
    executableSha256: '3331e1ffe19874215472217c5e94f5a0c6d8e18c4ac7111d3937aa0ad5e9b4a5',
    maxBytes: MAX_BYTES,
    // The tagged distribution LICENSE includes Node's bundled third-party notices.
    license: Object.freeze({
      url: 'https://raw.githubusercontent.com/nodejs/node/v24.15.0/LICENSE',
      sha256: '4573185d56580da2b890ba34a85a409257640f1c5632eade4300137266194d18',
      maxBytes: 1024 * 1024,
    }),
  }),
});

// Official release metadata and archive member hashes read 2026-09-11.
// Pins establish identity, NOT license approval or successful Mac execution.
const mac = (arch, cliArchive, cliExecutable, nodeArchive, nodeExecutable) => Object.freeze({
  cli: Object.freeze({
    ...ARTIFACTS.cli, platform: `darwin-${arch === 'x64' ? 'amd64' : arch}`,
    directory: `lark-cli-1.0.93-darwin-${arch === 'x64' ? 'amd64' : arch}`, name: 'lark-cli',
    url: `https://github.com/larksuite/cli/releases/download/v1.0.93/lark-cli-1.0.93-darwin-${arch === 'x64' ? 'amd64' : arch}.tar.gz`,
    sha256: cliArchive, executableSha256: cliExecutable, member: 'lark-cli', format: 'tar.gz',
  }),
  node: Object.freeze({
    ...ARTIFACTS.node, platform: `darwin-${arch}`, directory: `node-24.15.0-darwin-${arch}`, name: 'node',
    url: `https://nodejs.org/dist/v24.15.0/node-v24.15.0-darwin-${arch}.tar.gz`,
    sha256: nodeArchive, executableSha256: nodeExecutable,
    member: `node-v24.15.0-darwin-${arch}/bin/node`, format: 'tar.gz', maxBytes: 160 * 1024 * 1024,
  }),
});
export const ARTIFACTS_BY_TARGET = Object.freeze({
  'win32-x64': ARTIFACTS,
  'darwin-arm64': mac('arm64',
    'eaa09754925c00a6858e91518a49ab8e0a24bd4178e4698a7b185046b8ea24e2',
    '9092c3f255b749afdc2a842be5d582511d978424c11326d59af90c0fd5f5c044',
    '372331b969779ab5d15b949884fc6eaf88d5afe87bde8ba881d6400b9100ffc4',
    '3200fbd9f7fd4410426dd541e10d1ab829d3472f270d743c7fabd1696c03fe32'),
  'darwin-x64': mac('x64',
    'bf37861ce5b5fb10c093ffd8b7305f2a80349280cf32563267c29f81cb864e53',
    '8264bb7982df6c4f89ddea5635f7986352d371fb09a33fad5bf3352caa24f9ba',
    'ffd5ee293467927f3ee731a553eb88fd1f48cf74eebc2d74a6babe4af228673b',
    '2a249a6a7015b0555c3448a77d226c1f3c8f62bd133d89044a2e1518cd16c4b3'),
});
export function runtimeArtifacts(platform = process.platform, arch = process.arch) {
  const artifacts = ARTIFACTS_BY_TARGET[`${platform}-${arch}`];
  if (!artifacts) throw Object.assign(new Error('UNSUPPORTED_PLATFORM'), { code: 'UNSUPPORTED_PLATFORM' });
  return artifacts;
}

export const NOTICE = `TuanTuan private runtime installation
CLI: larksuite/cli v1.0.93; upstream root license: MIT.
Node.js: v24.15.0; LICENSE preserves the upstream multi-party license text.
Full applicable third-party notices and source availability are in licenses/.
Automatic provisioning requires the packaged manifest's exact-artifact approval
and verifies bundled and installed notice sizes and SHA-256 hashes.
Artifact URLs and SHA-256 pins are recorded in the installation ownership marker.
SHA-256 verification is not Authenticode or signed-checksum verification.
The review is an engineering record, not legal certification or a reproducible
build attestation. Root licensing is not a blanket dependency clearance, and
limited artifact exceptions do not authorize other copyleft components.
Provisioning does not install npm packages or change global PATH, registry
settings or native configuration. Version probes disable remote metadata and
update/skills notifiers; provisioning never initializes CLI configuration.
`;
