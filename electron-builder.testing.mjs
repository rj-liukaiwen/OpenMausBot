import ruijie from "./electron-builder.ruijie.mjs";
const base = structuredClone(ruijie);

// Evaluation releases belong only to this private repository. No account token
// is embedded in the app. Download updates while signed into GitHub in a browser.
export default {
  ...base,
  extraResources: [...base.extraResources, { from: "build/private-release.json", to: "private-release.json" }],
  publish: [{ provider: "github", owner: "rj-liukaiwen", repo: "OpenMausBot", private: true }],
  mac: { ...base.mac, identity: "-", notarize: false },
  dmg: { ...base.dmg, sign: false },
};
