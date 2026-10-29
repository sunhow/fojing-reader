/* Validate startup dependencies before opening the reader; retry a failed resource once. */
(function(){
  'use strict';
  var message=document.getElementById('startupMessage');
  function tell(text){if(message&&message.isConnected)message.textContent=text;}
  var timer=setTimeout(function(){tell('网络加载较慢，正在等待书架。你也可以点击重新加载。');},12000);
  var sources=Array.from(document.querySelectorAll('script[data-src]')).map(function(el){return el.dataset.src;});
  function valid(src){
    if(/(?:^|\/)config\.js(?:\?|$)/.test(src))return !!window.SITE_CONFIG;
    if(/(?:^|\/)book\.js(?:\?|$)/.test(src))return !!(window.BOOK&&Array.isArray(window.BOOK.chapters)&&Array.isArray(window.BOOK.readingOrder));
    if(/(?:^|\/)foundations\.js(?:\?|$)/.test(src))return Array.isArray(window.FOUNDATIONS);
    return true;
  }
  function next(index,retry){
    if(index===sources.length){clearTimeout(timer);return;}
    var src=sources[index],script=document.createElement('script');
    script.src=src+(retry?(src.indexOf('?')===-1?'?':'&')+'retry=1':'');script.async=false;
    function failed(){
      script.onload=null;script.onerror=null;script.remove();
      // Never run a partially executed application twice.
      if(!retry&&!/(?:^|\/)app\.js(?:\?|$)/.test(src)){
        tell('连接刚才中断，正在自动重试…');next(index,true);return;
      }
      clearTimeout(timer);tell('书架暂未加载完成，请检查网络后点击重新加载。笔记与进度会保留。');
    }
    script.onload=function(){if(!valid(src)){failed();return;}next(index+1,false);};
    script.onerror=failed;
    document.body.appendChild(script);
  }
  next(0,false);
})();
