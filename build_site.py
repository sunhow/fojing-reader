#!/usr/bin/env python3
"""Validate content, version the offline cache, and assemble GitHub Pages assets."""
from pathlib import Path
import hashlib,shutil,re,runpy,json
ROOT=Path(__file__).resolve().parent
runpy.run_path(str(ROOT/'build.py'),run_name='__main__')
media=sorted(p.name for p in ROOT.glob('audio-fahua-*.m4a'))
assets=['index.html','manifest.webmanifest','style.css','library.css','config.js','app.js','book.js','foundations.js','icon-192.png','icon-512.png','icon-maskable-512.png','apple-touch-icon.png','favicon-32.png']
# A fresh HTML document must bypass assets held by an older service worker.
# Derive URLs from content so repeated builds are stable and offline precaching agrees.
versioned={name:name+'?v='+hashlib.sha256((ROOT/name).read_bytes()).hexdigest()[:14] for name in assets if name!='index.html'}
html=(ROOT/'index.html').read_text()
html=re.sub(r'(src|href)="([^"?]+)(?:\?v=[a-f0-9]+)?"',lambda m:m[1]+'="'+versioned.get(m[2],m[2])+'"',html)
(ROOT/'index.html').write_text(html)
paths=[]
for item in assets:
 p=ROOT/item
 paths.extend(sorted(p.rglob('*')) if p.is_dir() else [p])
digest=hashlib.sha256()
for p in paths:
 if p.is_file():digest.update(p.relative_to(ROOT).as_posix().encode());digest.update(p.read_bytes())
sw=(ROOT/'sw.js').read_text()
precache=['./','./index.html']+['./'+versioned[name] for name in assets if name!='index.html']
sw=re.sub(r'const ASSETS = [^\n]+;', 'const ASSETS = '+json.dumps(precache,separators=(',',':'))+';',sw)
digest.update(re.sub(r"const VERSION = '[^']+';","const VERSION = '';",sw).encode())
sw=re.sub(r"const VERSION = '[^']+';",f"const VERSION = '{digest.hexdigest()[:14]}';",sw)
(ROOT/'sw.js').write_text(sw)
out=ROOT/'dist'
if out.exists():shutil.rmtree(out)
out.mkdir()
source_files=['source-'+code+'.xml' for code in ['T09n0262','T34n1718','T10n0279','T35n1735']]
for item in assets+['sw.js','LICENSE','SOURCES.md','CBETA-LICENSE.md']+source_files+media+['audio-manifest.json']:
 p=ROOT/item
 if p.is_dir():shutil.copytree(p,out/item)
 else:shutil.copy2(p,out/item)
(out/'.nojekyll').touch()
print('Static site ready:',out)
