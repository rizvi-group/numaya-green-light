/**
 * Re-encode every recorded demo to H.264 MP4.
 *
 * Playwright records VP8 in a WebM container. That plays in any browser and in
 * VLC and in almost nothing else — double-clicking one on a stock Windows or
 * macOS machine is a coin toss, and these videos exist to be sent to people who
 * will double-click them. So the WebM is the master and the MP4 is the copy that
 * actually opens.
 *
 * Requires `ffmpeg` on PATH. If it is missing this exits with a message rather
 * than failing silently, because a missing MP4 is easy not to notice.
 *
 *   node demos/encode-mp4.mjs
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUTPUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'output');

const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });

if (probe.error !== undefined || probe.status !== 0) {
  console.error(
    'ffmpeg is not on PATH, so no MP4s were produced. The .webm files in ' +
      `${OUTPUT_DIR} are complete and play in any browser and in VLC.`,
  );
  process.exit(1);
}

let sources;

try {
  sources = readdirSync(OUTPUT_DIR).filter((name) => name.endsWith('.webm'));
} catch {
  console.error(`No recordings in ${OUTPUT_DIR}. Record them first:`);
  console.error('  npx playwright test --config playwright.demos.config.ts');
  process.exit(1);
}

if (sources.length === 0) {
  console.error(`No .webm recordings in ${OUTPUT_DIR}.`);
  process.exit(1);
}

for (const source of sources.sort()) {
  const input = path.join(OUTPUT_DIR, source);
  const output = input.replace(/\.webm$/, '.mp4');

  const result = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-i',
      input,
      // Playwright's WebM is variable frame rate and starts at an arbitrary
      // timestamp; both upset players that expect a well-formed MP4.
      '-r',
      '25',
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '22',
      // yuv420p and even dimensions are what QuickTime and Windows Media
      // Player will accept. Text-heavy screen capture stays sharp at CRF 22.
      '-pix_fmt',
      'yuv420p',
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-movflags',
      '+faststart',
      '-an',
      output,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' },
  );

  if (result.status !== 0) {
    console.error(`FAILED ${source}`);
    console.error(result.stderr?.slice(-2_000) ?? '');
    process.exitCode = 1;
    continue;
  }

  const bytes = statSync(output).size;
  console.log(
    `${path.basename(output)}  ${(bytes / 1024 / 1024).toFixed(1)} MB`,
  );
}
