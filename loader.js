/* Keep a slow or failed dependency from leaving the reading area blank. */
(function(){
  'use strict';
  var message=document.getElementById('startupMessage');
  var timer=setTimeout(function(){if(message&&message.isConnected)message.textContent='加载时间较长，请检查网络，或点击重新加载。';},12000);
  var sources=Array.from(document.querySelectorAll('script[data-src]')).map(function(el){return el.dataset.src;});
  function next(index){
    if(index===sources.length){clearTimeout(timer);return;}
    var script=document.createElement('script');script.src=sources[index];script.async=false;
    script.onload=function(){next(index+1);};
    script.onerror=function(){clearTimeout(timer);if(message&&message.isConnected)message.textContent='书架资源加载失败，请检查网络后重新加载。';};
    document.body.appendChild(script);
  }
  next(0);
})();
