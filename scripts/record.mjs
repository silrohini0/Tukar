import puppeteer from "puppeteer-core";
const CHROME = process.env.CHROME_PATH || (process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : undefined);
const URL = process.argv[2] || "http://localhost:8000/";
const OUT = process.argv[3] || "demo.webm";
const SECS = Number(process.argv[4] || 6);
const b = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
await p.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });
let rec;
try {
  rec = await p.screencast({ path: OUT });
} catch (e) {
  console.log("SCREENCAST UNSUPPORTED:", e.message);
  await b.close();
  process.exit(2);
}
await new Promise((r) => setTimeout(r, SECS * 1000));
await rec.stop();
console.log("recorded", OUT);
await b.close();
