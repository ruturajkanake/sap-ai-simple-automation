import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { runSapTestAgent } from './agent.js';

const [url, ...goalParts] = process.argv.slice(2);
const goal = goalParts.join(' ').trim();
if (!url || !goal) {
  console.error('Usage: npm start -- <sap-url> "<plain-text testing goal>"');
  process.exit(2);
}

const artifactDir = path.resolve('artifacts', new Date().toISOString().replaceAll(':', '-'));
await fs.mkdir(artifactDir, { recursive: true });
const browser = await puppeteer.launch({ headless: process.env.HEADLESS !== 'false' });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  const result = await runSapTestAgent({
    page, url, goal, artifactDir,
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
    maxSteps: Number(process.env.MAX_STEPS || 25)
  });
  await fs.writeFile(path.join(artifactDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(`Test ${result.status}. Artifacts: ${artifactDir}`);
  process.exitCode = result.status === 'done' ? 0 : 1;
} finally {
  await browser.close();
}
