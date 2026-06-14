// Rasterizes an SVG to PNG at a given width. One-off tool; install first:
//   npm install @resvg/resvg-js --no-save
//   node scripts/render-png.mjs <input.svg> <output.png> <width>
import { readFileSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const [, , input, output, width] = process.argv;
const svg = readFileSync(input, "utf8");
const png = new Resvg(svg, {
  fitTo: { mode: "width", value: Number(width) },
  background: "#0f0f0f",
}).render().asPng();
writeFileSync(output, png);
console.log(`Wrote ${output} (${png.length} bytes)`);
