// Render scripts/og/og.html to web/og.png (1200×630) with headless Chrome.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=1200,630', '--virtual-time-budget=4000',
  `--screenshot=${resolve('web/og.png')}`, `file://${resolve('scripts/og/og.html')}`], { stdio: 'inherit' });
console.log('wrote web/og.png');
