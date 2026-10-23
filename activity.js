// music-suite activity tracker
// Records semantic production events locally so flow-hub can inherit reliable production context.
(function(){
  const KEY='msuite_activity_v1';
  const SESSION='msuite_activity_session_v1';
  const MAX=160;
  const page=location.pathname.split('/').pop()||'index.html';
  const app=page==='index.html'?'music-suite':page.replace(/\.html$/,'');
  const stageMap={
    'vocal-lab-v3':'capture','canvas':'arrange','composition-canvas':'arrange',
    'chord-lab':'compose','beat-lab':'compose','score-editor-v2':'produce','music-suite':'plan'
  };
  const stage=stageMap[app]||'produce';
  const labelMap={
    'vocal-lab-v3':'Vocal Lab',canvas:'Canvas','composition-canvas':'Composition Canvas',
    'chord-lab':'Chord Lab','beat-lab':'Beat Lab','score-editor-v2':'Score Editor','music-suite':'music-suite'
  };
  const semanticTypes=new Set(['opened','edited','saved','exported','completed','sent','reviewed']);
  function read(k){try{return JSON.parse(localStorage.getItem(k)||'[]')}catch(e){return[]}}
  function write(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}
  function cleanText(v){return String(v||'').replace(/\s+/g,' ').trim().slice(0,120)}
  function push(ev){
    const all=read(KEY);all.push(ev);while(all.length>MAX)all.shift();write(KEY,all);
    const session=read(SESSION);session.push(ev);write(SESSION,session);
    return ev;
  }
  function record(action,detail,meta){
    return push({at:new Date().toISOString(),app,stage,kind:'action',action:cleanText(action),detail:cleanText(detail),...(meta||{})});
  }
  function semantic(type,detail,meta){
    if(!semanticTypes.has(type)) throw new TypeError('Unknown semantic event: '+type);
    return push({at:new Date().toISOString(),app,stage,kind:'semantic',type,detail:cleanText(detail),...(meta||{})});
  }
  function mark(type,detail,meta){return semantic(type,detail,meta)}
  function clearSession(){write(SESSION,[])}
  function session(){return read(SESSION)}
  function all(){return read(KEY)}
  function projectName(){
    const ids=['project-name','projectName','song-name','songName'];
    for(const id of ids){const el=document.getElementById(id);if(el&&cleanText(el.value))return cleanText(el.value)}
    return null;
  }
  function inferSemantic(text){
    const t=cleanText(text);
    if(/エクスポート|書き出し|export/i.test(t)) return 'exported';
    if(/送る|送信|score.?editorへ|共有|handoff|send/i.test(t)) return 'sent';
    if(/保存|セーブ|save/i.test(t)) return 'saved';
    if(/完成|完了|確定|コミット|commit|採用|決定/i.test(t)) return 'completed';
    if(/編集|修正|変更|補正|並べ|移動|追加|削除|生成|録音|記録/i.test(t)) return 'edited';
    if(/開く|open|起動/i.test(t)) return 'opened';
    return null;
  }
  window.MusicActivity={record,semantic,mark,clearSession,session,all,projectName,app,stage};
  if(!session().some(e=>e.kind==='semantic'&&e.type==='opened')) semantic('opened',labelMap[app]||app);
  document.addEventListener('click',function(e){
    const el=e.target.closest('button,a,[role="button"],[data-action],[data-tab]');
    if(!el)return;
    const text=cleanText(el.innerText||el.getAttribute('aria-label')||el.getAttribute('title')||el.dataset.action||el.dataset.tab);
    if(!text)return;
    record('click',text);
    const type=el.dataset.activityEvent||inferSemantic(text);
    if(type) semantic(type,text,{source:el.dataset.activityEvent?'explicit-ui':'ui'});
  },true);
  document.addEventListener('change',function(e){
    const el=e.target;
    if(!el||el.type==='password')return;
    const name=cleanText(el.id||el.name||el.getAttribute('aria-label')||el.type);
    if(name){record('change',name);semantic('edited',name,{source:'input'});}
  },true);
  window.addEventListener('beforeunload',function(){
    const p=projectName();if(p)record('project',p);
  });
})();
