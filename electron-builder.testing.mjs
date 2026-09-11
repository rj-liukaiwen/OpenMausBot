import ruijie from "./electron-builder.ruijie.mjs";
import { verifyDesktopBuildReceipt } from "./scripts/desktop-build-receipt.mjs";
const { beforePack: productionAcceptanceGate, ...serializable } = ruijie;
const base = structuredClone(serializable);

// The owner explicitly waived the new human acceptance receipts for evaluation
// releases. Keep build provenance and afterPack integrity checks; never create
// fake passing receipts or change the production acceptance gate.
export default {
  ...base,
  beforePack() { verifyDesktopBuildReceipt(); },
  artifactName: "RuijieBot-${version}-${arch}.${ext}",
  extraResources: [...base.extraResources, { from: "build/private-release.json", to: "private-release.json" }],
  publish: [{ provider: "github", owner: "rj-liukaiwen", repo: "OpenMausBot" }],
  mac: { ...base.mac, identity: "-", notarize: false, signIgnore: ["tuantuan-feishu-runtime/"] },
  linux: { ...base.linux, desktop: { ...base.linux.desktop, entry: { ...base.linux.desktop.entry, Name: "锐捷Bot" } } },
  dmg: { ...base.dmg, sign: false },
};
