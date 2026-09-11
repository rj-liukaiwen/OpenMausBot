import path from 'node:path';
import { realpathSync } from 'node:fs';

/** Content mode never changes application identity, data directories or updater mode. */
export function desktopRuntimeLayout({ packaged, preview, appRoot, resourcesPath, platform, arch, resolveResourceRoot = realpathSync }) {
  const built = packaged || preview;
  // The desktop's own checkout may be reached through a Windows junction.
  // Canonicalize only this trusted native-resource root, never saved user
  // contexts or arbitrary executables. Runtime no-junction checks stay intact.
  const nativeRoot = !packaged && preview ? resolveResourceRoot(appRoot) : appRoot;
  return {
    built,
    server: packaged ? path.join(resourcesPath, 'server/index.js')
      : path.join(appRoot, preview ? 'dist-server/index.js' : 'server/index.ts'),
    ui: packaged ? path.join(resourcesPath, 'ui') : path.join(appRoot, 'dist'),
    browser: packaged ? path.join(resourcesPath, 'browser-engine')
      : preview ? path.join(nativeRoot, 'dist-native/browser', `${platform}-${arch}`) : undefined,
    feishu: packaged ? path.join(resourcesPath, 'tuantuan-feishu-runtime')
      : preview ? path.join(nativeRoot, 'dist-native/feishu-runtime', `${platform}-${arch}`) : undefined,
  };
}
