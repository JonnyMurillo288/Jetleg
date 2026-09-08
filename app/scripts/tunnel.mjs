/**
 * Serve the production build over a public HTTPS URL via a Cloudflare quick
 * tunnel, and print it big enough to type into a phone.
 *
 * Why a tunnel rather than just the LAN address: geolocation only works on a
 * secure origin. A quick tunnel gets a real certificate, so there is no
 * warning to click through and no per-device trust to set up — and it works
 * even if the phone is on cellular rather than the same wifi.
 *
 * The URL is public but unguessable, and it dies when this process does.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 4173);

if (!existsSync(join(root, 'dist', 'index.html'))) {
  console.error('No build found. Run `npm run build` first.');
  process.exit(1);
}

const children = [];
const stop = () => { for (const c of children) c.kill('SIGTERM'); };
process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });

console.log(`Serving dist/ on :${PORT} …`);
const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1'], {
  cwd: root, stdio: 'ignore',
});
children.push(preview);

await new Promise((r) => setTimeout(r, 3000));

console.log('Opening Cloudflare tunnel …\n');
const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${PORT}`], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(tunnel);

let announced = false;
const scan = (buf) => {
  const text = String(buf);
  const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (match && !announced) {
    announced = true;
    const url = match[0];
    const bar = '─'.repeat(url.length + 4);
    console.log(`\n┌${bar}┐`);
    console.log(`│  ${url}  │`);
    console.log(`└${bar}┘\n`);
    console.log('Open that on your phone. Location will work — it is real HTTPS.');
    console.log('Then use Share → Add to Home Screen so the round survives a tab close.');
    console.log('\nCtrl-C here shuts the tunnel down.\n');
  }
  if (/ERR|failed/i.test(text) && !announced) process.stderr.write(text);
};

tunnel.stdout.on('data', scan);
tunnel.stderr.on('data', scan); // cloudflared prints the URL on stderr

tunnel.on('exit', (code) => {
  console.error(`\ncloudflared exited (${code}).`);
  stop();
  process.exit(code ?? 1);
});
