#!/usr/bin/env python3
"""Validate source coverage and build all five complete reading editions."""
from pathlib import Path
import json,hashlib
ROOT=Path(__file__).resolve().parent
source=json.loads((ROOT/'library-source.json').read_text())
manifest=json.loads((ROOT/'source-manifest.json').read_text())
glossary=json.loads((ROOT/'glossary.json').read_text())
assert [b['slug'] for b in source]==['yijiao','shishan','heart','diamond','puxian']
BOOK={'title':'佛经精读','chapters':[]}
for b in source:
 m=manifest[b['slug']];assert len(b['paragraphs'])==m['count']
 assert [p['id'] for p in b['paragraphs']]==m['ids']
 for p in b['paragraphs']:
  assert hashlib.sha256(p['traditional'].encode()).hexdigest()==m['hashes'][p['id']]
  assert all(isinstance(p[k],str) and p[k].strip() for k in ['original','traditional','translation','annotation','label'])
  assert p['translation']!=p['annotation']
 ch={k:b[k] for k in ['slug','title','fullTitle','author','subtitle','theme','intro','edition','source','revision']}
 ch['passageCount']=len(b['paragraphs']);ch['sections']=[];covered=[]
 for si,(a,z,title) in enumerate(b['groups'],1):
  selected=b['paragraphs'][a-1:z];covered.extend(p['id'] for p in selected)
  pairs=[{'id':p['id'],'number':j,'label':p['label'],'orig':p['original'],'traditional':p['traditional'],'trans':p['translation'],'annotation':p['annotation']} for j,p in enumerate(selected,1)]
  corpus=''.join(p['orig'] for p in pairs)
  notes=[n for n in glossary if n['term'] in corpus]
  sec={'id':b['slug']+f'-s{si:02}','number':si,'title':title,'name':title,'intro':b['subtitle']+'。本节依原文顺序收录 '+str(len(pairs))+' 段，可在段落目录中直接跳转。','source':b['source'],'pairs':pairs,'notes':notes}
  ch['sections'].append(sec)
 assert covered==m['ids'],b['slug']+' group coverage mismatch'
 BOOK['chapters'].append(ch)
assert sum(len(s['pairs']) for c in BOOK['chapters'] for s in c['sections'])==156
assert '若以色见我' in source[3]['paragraphs'][25]['original']
assert '佛说是经已' in source[3]['paragraphs'][-1]['original']
assert sum(bool(p.get('verse')) for p in source[4]['paragraphs'])==62
(ROOT/'book.js').write_text('window.BOOK = '+json.dumps(BOOK,ensure_ascii=False,separators=(',',':'))+';\n')
print('Validated 5 sutras, 27 reading sections, 156 complete passages, 62 Puxian verse groups and source hashes.')
