const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const config = getDefaultConfig(__dirname);

// Exclude project's server/ and scripts/ dirs from Metro — they're Node-only.
// Use anchored patterns to avoid blocking node_modules/@trpc/server/ etc.
config.resolver.blockList = [
  new RegExp(`^${escapeRegex(path.resolve(__dirname, "server"))}/.*`),
  new RegExp(`^${escapeRegex(path.resolve(__dirname, "scripts"))}/.*`),
];

module.exports = withNativeWind(config, { input: "./global.css" });
