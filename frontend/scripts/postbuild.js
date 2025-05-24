import { copyFile } from 'fs/promises';
import { resolve } from 'path';

const distDir = resolve('build'); // or 'dist' depending on your config

const indexPath = resolve(distDir, 'index.html');
const fallbackPath = resolve(distDir, '404.html');

await copyFile(indexPath, fallbackPath);
console.log('✅ Copied index.html → 404.html');
