/* Offline cache is isolated by repository path, including on shared GitHub Pages origins. */
const SCOPE = new URL(self.registration.scope).pathname;
const PREFIX = 'fojing:' + SCOPE + ':';
const VERSION = '10d85215287d51';
const CACHE = PREFIX + VERSION;
const ASSETS = ["./","./index.html","./manifest.webmanifest?v=5e1dc3e99016ba","./style.css?v=b9c3935f237672","./library.css?v=2cc18da14255f8","./config.js?v=0cf3df69ab80fa","./app.js?v=1393943c39f192","./loader.js?v=3a3b5fe3d1c0cf","./book.js?v=3af08740f65e1a","./foundations.js?v=f1eaa00712d9f0","./icon-192.png?v=f3fb3d8d9d3f42","./icon-512.png?v=2ee7d761d0534c","./icon-maskable-512.png?v=2ee7d761d0534c","./apple-touch-icon.png?v=e6c105376957bf","./favicon-32.png?v=3b068fac394a2a"];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS.map(url=>new Request(url,{cache:'reload'})))).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith(PREFIX)&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request=event.request, url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin||!url.pathname.startsWith(SCOPE))return;
  // Stream media directly, retaining browser Range support and avoiding bulk downloads.
  if(request.destination==='audio'||/\.(m4a|mp3)$/i.test(url.pathname))return;
  if(request.mode==='navigate'){
    event.respondWith(fetch(new Request(request,{cache:'no-cache'})).catch(()=>caches.open(CACHE).then(cache=>cache.match('./index.html'))));
    return;
  }
  // Book payloads are cached only after readers request them, never during installation.
  if(/\/reader-[a-z-]+\.json$/.test(url.pathname)){
    event.respondWith(caches.open(CACHE).then(async cache=>{
      const hit=await cache.match(request);if(hit)return hit;
      const response=await fetch(request);
      if(response.ok){const copy=response.clone();event.waitUntil(cache.put(request,copy).catch(()=>{}));}
      return response;
    }));return;
  }
  // Only serve assets from this site's own cache. User backups are never cached.
  event.respondWith(caches.open(CACHE).then(async cache=>{
    const hit=await cache.match(request);return hit||fetch(request);
  }));
});
