// Make a portable HTML sample. USB discovery still requires the Flask app.
const fs=require('node:fs');const path=require('node:path');
const root=path.join(__dirname,'..');let html=fs.readFileSync(path.join(root,'templates/index.html'),'utf8');
html=html.replace('<link rel="stylesheet" href="/static/css/style.css">',()=>`<style>${fs.readFileSync(path.join(root,'static/css/style.css'),'utf8')}</style>`);
for(const name of ['dsp','metadata','app'])html=html.replace(`<script src="/static/js/${name}.js"></script>`,()=>`<script>${fs.readFileSync(path.join(root,`static/js/${name}.js`),'utf8')}</script>`);
for(const [file,mime] of [['honda-emblem.svg','image/svg+xml'],['raspberry-pi.png','image/png']])html=html.replace(`/static/img/${file}`,()=>`data:${mime};base64,${fs.readFileSync(path.join(root,'static/img',file)).toString('base64')}`);
fs.writeFileSync(path.join(root,'civic-sound-studio.html'),html);console.log('Built civic-sound-studio.html');
