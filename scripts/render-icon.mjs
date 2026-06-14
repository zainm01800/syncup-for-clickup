// Rasterizes public/app-icon.svg -> app-icon-1200.png (the 1200x1200 file you
// upload as the Shopify app icon). One-off tool; install the renderer first:
//   npm install @resvg/resvg-js --no-save
//   node scripts/render-icon.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const svg = readFileSync("public/app-icon.svg", "utf8");
const resvg = new Resvg(svg, {
  fitTo: { mode: "width", value: 1200 },
  background: "#121212",
});
const png = resvg.render().asPng();
writeFileSync("app-icon-1200.png", png);
console.log(`Wrote app-icon-1200.png (${png.length} bytes)`);
