// music-suite activity tracker
// Records meaningful UI actions locally so flow-hub can inherit production context.
(function(){
  const KEY='msuite_activity_v1';
  const SESSION='msuite_activity_session_v1';
  const MAX=120;
  const page=location.pathname.split('/').pop()||'index.html';
  const app=page==='index.html'?'music-suite':page.replace(/\.html$/,'');
  const stageMap={
    'vocal-lab-v3':'capture',
    'canvas':'arrange',
    'composition-canvas':'arrange',
    'chord-lab':'compose',
    'beat-lab':'compose',
    'score-editor-v2':'produce',
    'music-suite':'plan'
  };
  const stage=stageMap[app]||'produce';
  const labelMap={
    'vocal-lab-v3':'Vocal Lab',canvas:'Canvas','composition-canvas':'Composition Canvas',
    'chord-lab':'Chord Lab','beat-lab':'Beat Lab','score-editor-v2':'Score Editor',
    'music-suite':'music-suite'
  };
  function read(k){try{return JSON.parse(localStorage.getItem(k)||'[]')}catch(e){return[]}}
  function write(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}
  function cleanText(v){return String(v||'').replace(/\s+/g,' ').trim().slice(0,100)}
  function record(action,detail){
    const ev={at:new Date().toISOString(),app,stage,action:cleanText(action),detail:cleanText(detail)};
    const all=read(KEY);all.push(ev);while(all.length>MAX)all.shift();write(KEY,all);
    const session=read(SESSION);session.push(ev);write(SESSION,session);
    return ev;
  }
  function clearSession(){write(SESSION,[])}
  function session(){return read(SESSION)}
  function all(){return read(KEY)}
  function projectName(){
    const ids=['project-name','projectName','song-name','songName'];
    for(const id of ids){const el=document.getElementById(id);if(el&&cleanText(el.value))return cleanText(el.value)}
    return null;
  }
  window.MusicActivity={record,clearSession,session,all,projectName,app,stage};
  if(!session().length) record('open',labelMap[app]||app);
  document.addEventListener('click',function(e){
    const el=e.target.closest('button,a,[role="button"],[data-action],[data-tab]');
    if(!el)return;
    const text=cleanText(el.innerText||el.getAttribute('aria-label')||el.getAttribute('title')||el.dataset.action||el.dataset.tab);
    if(!text)return;
    record('click',text);
  },true);
  document.addEventListener('change',function(e){
    const el=e.target;
    if(!el||el.type==='password')return;
    const name=cleanText(el.id||el.name||el.getAttribute('aria-label')||el.type);
    if(name)record('change',name);
  },true);
  window.addEventListener('beforeunload',function(){
    const p=projectName();if(p)record('project',p);
  });
})();
