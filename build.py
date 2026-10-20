#!/usr/bin/env python3
"""Validate nine reading editions and foundation guides, preserving stable route indices."""
from pathlib import Path
import json,hashlib
ROOT=Path(__file__).resolve().parent
source=json.loads((ROOT/'library-source.json').read_text())
manifest=json.loads((ROOT/'source-manifest.json').read_text())
glossary=json.loads((ROOT/'glossary.json').read_text())
assert [b['slug'] for b in source]==['yijiao','shishan','heart','diamond','puxian','bada','faju','amituo','dizang']
BOOK={'title':'佛经精读','readingOrder':[0,1,2,3,4,8,5,6,7],'chapters':[]}
for b in source:
 m=manifest[b['slug']];assert len(b['paragraphs'])==m['count']
 assert [p['id'] for p in b['paragraphs']]==m['ids']
 for p in b['paragraphs']:
  assert hashlib.sha256(p['traditional'].encode()).hexdigest()==m['hashes'][p['id']]
  assert all(isinstance(p[k],str) and p[k].strip() for k in ['original','traditional','translation','annotation','label'])
  assert p['translation']!=p['annotation']
 ch={k:b[k] for k in ['slug','title','fullTitle','author','subtitle','theme','intro','edition','source','revision']}
 ch['scope']=b.get('scope','full')
 ch['passageCount']=len(b['paragraphs']);ch['sections']=[];covered=[]
 for si,(a,z,title) in enumerate(b['groups'],1):
  selected=b['paragraphs'][a-1:z];covered.extend(p['id'] for p in selected)
  pairs=[{'id':p['id'],'number':j,'label':p['label'],'orig':p['original'],'traditional':p['traditional'],'trans':p['translation'],'annotation':p['annotation'],'citation':p.get('sourceChapter','') + (' · 起句「'+p['sourceOpening']+'」' if p.get('sourceOpening') else '')} for j,p in enumerate(selected,1)]
  corpus=''.join(p['orig'] for p in pairs)
  notes=[n for n in glossary if n['term'] in corpus]
  sec={'id':b['slug']+f'-s{si:02}','number':si,'title':title,'name':title,'intro':b['subtitle']+'。本节依原文顺序收录 '+str(len(pairs))+' 段，可在段落目录中直接跳转。','source':b['source'],'pairs':pairs,'notes':notes}
  if b.get('sectionMetadata'):sec.update(b['sectionMetadata'][si-1])
  ch['sections'].append(sec)
 assert covered==m['ids'],b['slug']+' group coverage mismatch'
 BOOK['chapters'].append(ch)
assert sum(len(s['pairs']) for c in BOOK['chapters'] for s in c['sections'])==359
assert len({s['id'] for c in BOOK['chapters'] for s in c['sections']})==51
assert [len(s['pairs']) for s in BOOK['chapters'][8]['sections']]==[16,4,10,20,6,19,8,16,13,12,5,15,9]
assert '若以色见我' in source[3]['paragraphs'][25]['original']
assert '佛说是经已' in source[3]['paragraphs'][-1]['original']
assert sum(bool(p.get('verse')) for p in source[4]['paragraphs'])==62
(ROOT/'book.js').write_text('window.BOOK = '+json.dumps(BOOK,ensure_ascii=False,separators=(',',':'))+';\n')
foundations=json.loads((ROOT/'foundations-source.json').read_text())
assert len(foundations)==12 and len({t['id'] for t in foundations})==12
ids={t['id'] for t in foundations}; passagerefs={}
for ci,ch in enumerate(BOOK['chapters']):
 for si,sec in enumerate(ch['sections']):
  for pi,p in enumerate(sec['pairs']):passagerefs[p['id']]={'id':p['id'],'book':ch['title'],'label':p['label'],'href':'#/passage/'+p['id']}
for t in foundations:
 assert all(t.get(k) for k in ['id','title','summary','paragraphs','misconception','example','readings'])
 assert all(x in ids for x in t['related'])
 assert all(x in passagerefs for x in t['readings'])
 t['references']=[passagerefs[x] for x in t['readings']]
(ROOT/'foundations.js').write_text('window.FOUNDATIONS = '+json.dumps(foundations,ensure_ascii=False,separators=(',',':'))+';\n')
print('Validated 9 books, 51 sections, 359 passages, 12 linked foundation guides and source hashes.')
