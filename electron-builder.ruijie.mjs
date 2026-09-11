import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { beforeRuijiePack } from './scripts/check-ruijie-release-readiness.mjs';
import { releaseBrokerUrl } from './electron/connected-apps-release.mjs';

// electron-builder's `extends` concatenates publish arrays: the upstream feed
// would remain first. Load the common config and REPLACE that array instead.
const upstream = parse(readFileSync(new URL("./electron-builder.yml", import.meta.url), "utf8"));
export default {
  ...upstream,
  beforePack: beforeRuijiePack,
  extraMetadata: { ...upstream.extraMetadata,
    ruijieConnectedAppsBrokerUrl: releaseBrokerUrl(process.env.RUIJIE_COMPOSIO_BROKER_URL),
  },
  mac: { ...upstream.mac, artifactName: 'RuijieBot-${version}-mac-${arch}.${ext}' },
  dmg: { ...upstream.dmg, artifactName: 'RuijieBot-${version}-mac-${arch}.dmg' },
  publish: [{ provider: "github", owner: "WYunS", repo: "OpenMausBot" }],
};
