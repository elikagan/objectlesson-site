#!/usr/bin/env node
// One-time script: optimize all existing product images and generate thumbnails
// Usage: node optimize-images.mjs

import sharp from 'sharp';
import { readdir, stat } from 'fs/promises';
import { join } from 'path';

const PRODUCTS_DIR = 'images/products';
const MAX_DIM = 1200;
const QUALITY = 82;
const THUMB_DIM = 400;
const THUMB_QUALITY = 75;

let totalBefore = 0, totalAfter = 0, thumbsCreated = 0, processed = 0, errors = 0;

const dirs = await readdir(PRODUCTS_DIR);
for (const dir of dirs.sort()) {
  const dirPath = join(PRODUCTS_DIR, dir);
  const s = await stat(dirPath);
  if (!s.isDirectory()) continue;

  const files = await readdir(dirPath);
  const jpgs = files.filter(f => f.endsWith('.jpg') && !f.startsWith('thumb_'));

  for (const file of jpgs) {
    const filePath = join(dirPath, file);
    const thumbPath = join(dirPath, `thumb_${file}`);

    try {
      const before = (await stat(filePath)).size;
      totalBefore += before;

      // Optimize full image
      const img = sharp(filePath);
      const meta = await img.metadata();
      const scale = Math.min(1, MAX_DIM / Math.max(meta.width, meta.height));
      const w = Math.round(meta.width * scale);
      const h = Math.round(meta.height * scale);

      await sharp(filePath)
        .resize(w, h, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: QUALITY, mozjpeg: true })
        .toFile(filePath + '.tmp');

      // Replace original
      const { rename } = await import('fs/promises');
      await rename(filePath + '.tmp', filePath);

      const after = (await stat(filePath)).size;
      totalAfter += after;

      // Generate thumbnail
      await sharp(filePath)
        .resize(THUMB_DIM, THUMB_DIM, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: THUMB_QUALITY, mozjpeg: true })
        .toFile(thumbPath);
      thumbsCreated++;

      const pct = Math.round((1 - after / before) * 100);
      const thumbSize = (await stat(thumbPath)).size;
      console.log(`${filePath}: ${(before/1024).toFixed(0)}KB → ${(after/1024).toFixed(0)}KB (${pct}% smaller) + thumb ${(thumbSize/1024).toFixed(0)}KB`);
      processed++;
    } catch (e) {
      console.error(`ERROR ${filePath}: ${e.message}`);
      errors++;
    }
  }
}

console.log(`\n--- DONE ---`);
console.log(`Processed: ${processed} images`);
console.log(`Thumbnails created: ${thumbsCreated}`);
console.log(`Total before: ${(totalBefore/1024/1024).toFixed(1)} MB`);
console.log(`Total after: ${(totalAfter/1024/1024).toFixed(1)} MB`);
console.log(`Saved: ${((totalBefore-totalAfter)/1024/1024).toFixed(1)} MB (${Math.round((1-totalAfter/totalBefore)*100)}%)`);
if (errors) console.log(`Errors: ${errors}`);
