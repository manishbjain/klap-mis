// Optional: strips decorative emoji from labels so the line-icon look stays clean.
(function(){
  const EMO=/^[\s‍️←-⯿☀-➿\u{1F000}-\u{1FAFF}]+/u;
  const sel='#tab-bar .wft,.wft,.sc .l,.th h3,.pn .pl,.pwx-stat .l,.kb-hdr-title,.dq-col-title,.fgv button,.pipe h3';
  const run=()=>document.querySelectorAll(sel).forEach(el=>{
    el.childNodes.forEach(n=>{if(n.nodeType===3&&EMO.test(n.textContent))n.textContent=n.textContent.replace(EMO,'');});
    const f=el.firstElementChild; if(f&&!f.children.length&&EMO.test(f.textContent)&&f.textContent.replace(EMO,'')==='')f.style.display='none';
  });
  run(); new MutationObserver(()=>{clearTimeout(window.__kc);window.__kc=setTimeout(run,60);}).observe(document.body,{childList:true,subtree:true});
})();
