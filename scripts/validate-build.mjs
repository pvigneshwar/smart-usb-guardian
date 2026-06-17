import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, dirname } from "node:path";

const required = [
  "site/index.html",
  "site/app.js",
  "site/config.js",
  "site/styles.css",
  "site/three-d.css",
  "site/experience.js",
  "site/service-worker.js",
  "site/manifest.webmanifest",
  "site/assets/logo.svg",
  "site/assets/apple-touch-icon.png",
  "site/assets/icon-192.png",
  "site/assets/icon-512.png",
  "site/downloads/Open_Secure_USB.exe",
  "site/downloads/USBMonitor.exe",
  "site/downloads/USBGuardianMobile.apk",
  "site/downloads/Smart_USB_Guardian_One_Click_Setup.zip",
  "site/downloads/Smart_USB_Guardian_Windows_Client.zip",
  "netlify/functions/api.mjs",
  "netlify.toml",
];

for (const file of required) {
  await access(file, constants.R_OK);
}

const config = await readFile("site/config.js", "utf8");
if (config.includes("onrender.com") || config.includes("192.168.") || config.includes("http://https")) {
  throw new Error("site/config.js contains an invalid or external backend URL.");
}

const index = await readFile("site/index.html", "utf8");
const localReferences = [...index.matchAll(/(?:src|href)=["']([^"'#?]+)["']/g)]
  .map((match) => match[1])
  .filter((value) => !/^(?:https?:|mailto:|tel:|data:)/i.test(value));

for (const reference of localReferences) {
  const relative = reference.startsWith("/") ? `site${reference}` : resolve(dirname("site/index.html"), reference);
  await access(relative, constants.R_OK).catch(() => {
    throw new Error(`Broken local reference in site/index.html: ${reference}`);
  });
}

const binaryMinimums = {
  "site/downloads/Open_Secure_USB.exe": 1_000_000,
  "site/downloads/USBMonitor.exe": 1_000_000,
  "site/downloads/USBGuardianMobile.apk": 500_000,
};
for (const [file, minimum] of Object.entries(binaryMinimums)) {
  const details = await stat(file);
  if (details.size < minimum) throw new Error(`${file} is unexpectedly small and may be broken.`);
}

JSON.parse(await readFile("site/manifest.webmanifest", "utf8"));
console.log("Smart USB Guardian Netlify build validation passed: assets and download links verified.");
