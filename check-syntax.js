import fs from 'fs';
const content = fs.readFileSync('public/index.html', 'utf8');
const match = content.match(/<script>([\s\S]*)<\/script>/);
if (match) {
  try {
    new Function(match[1]);
    console.log('✅ JavaScript syntax is valid');
  } catch (e) {
    console.log('❌ Syntax Error:', e.message);
  }
}
