const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, '..', 'printone.html');
const dstDir = path.join(root, 'app');
fs.mkdirSync(dstDir, { recursive: true });
fs.copyFileSync(src, path.join(dstDir, 'index.html'));
fs.mkdirSync(path.join(root, 'models'), { recursive: true });
console.log('Copied printone.html -> app/index.html');
