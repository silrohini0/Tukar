import puppeteer from "puppeteer-core";
const CHROME = process.env.CHROME_PATH || (process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : undefined);
const URL = process.argv[2] || "http://localhost:8000/";
const OUT = process.argv[3] || "shot.png";
const full = process.argv[4] !== "viewport";
const b = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
const p = await b.newPage();
await p.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
await p.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });
await new Promise((r) => setTimeout(r, 1500));
await p.evaluate(async () => {
  document.querySelectorAll(".reveal").forEach((el) => el.classList.add("in"));
  window.scrollTo(0, 0);
});
await new Promise((r) => setTimeout(r, 700));
await p.screenshot({ path: OUT, fullPage: full });
console.log("saved", OUT);
await b.close();
