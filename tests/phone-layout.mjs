// Real-browser phone check. Run on your own computer (needs a browser download):
//   cd tests && npm i -D playwright && npx playwright install chromium
//   node phone-layout.mjs http://localhost:8080/
// It opens the landing page at phone and tablet sizes, reports anything that spills
// sideways off the screen, and saves screenshots to tests/out/.
import { chromium } from "playwright";
import fs from "node:fs";

const url = process.argv[2] || "http://localhost:8080/";
const sizes = [[360, 780], [390, 844], [768, 1024]];
fs.mkdirSync("out", { recursive: true });
const browser = await chromium.launch();
let problems = 0;
for (const [w, h] of sizes) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, isMobile: w < 500, hasTouch: w < 500 });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const report = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const wide = [];
    document.querySelectorAll("body *").forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 1 && getComputedStyle(el).position !== "fixed") {
        wide.push((el.id ? "#" + el.id : el.tagName.toLowerCase()) + " right=" + Math.round(r.right));
      }
    });
    return { scrollWidth: document.documentElement.scrollWidth, vw, wide: wide.slice(0, 8) };
  });
  const ok = report.scrollWidth <= report.vw + 1 && report.wide.length === 0;
  if (!ok) problems++;
  console.log(`${w}x${h}: ${ok ? "OK" : "SIDEWAYS OVERFLOW"} ${JSON.stringify(report)}`);
  await page.screenshot({ path: `out/landing-${w}.png`, fullPage: false });
  await page.close();
}
await browser.close();
process.exit(problems ? 1 : 0);
