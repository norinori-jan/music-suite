// Build a hub_handoff_v1 activity payload from the current music-suite session.
(function(){
  const APP='music-suite';
  const SESSION='msuite_activity_session_v1';
  const urls={
    'music-suite':'https://norinori-jan.github.io/music-suite/',
    'vocal-lab-v3':'https://norinori-jan.github.io/music-suite/apps/vocal-lab-v3.html',
    'canvas':'https://norinori-jan.github.io/music-suite/apps/canvas.html',
    'chord-lab':'https://norinori-jan.github.io/music-suite/apps/chord-lab.html',
    'beat-lab':'https://norinori-jan.github.io/music-suite/apps/beat-lab.html',
    'score-editor-v2':'https://norinori-jan.github.io/music-suite/apps/score-editor-v2.html'
  };
  const labels={'vocal-lab-v3':'Vocal Lab','canvas':'Canvas','chord-lab':'Chord Lab','beat-lab':'Beat Lab','score-editor-v2':'Score Editor','music-suite':'music-suite'};
  const stageLabels={capture:'素材・メロディ',compose:'作曲',arrange:'構成・アレンジ',produce:'最終編集・出力',plan:'制作計画'};
  const advancement=new Set(['saved','exported','completed','sent']);
  function read(){try{return JSON.parse(localStorage.getItem(SESSION)||'[]')}catch(e){return[]}}
  function clean(v){return String(v||'').replace(/\s+/g,' ').trim().slice(0,120)}
  function unique(a){return [...new Set(a.filter(Boolean))]}
  function build(){
    const events=read();
    const apps=unique(events.map(e=>e.app));
    const current=events.length?events[events.length-1]:null;
    const semantic=events.filter(e=>e.kind==='semantic');
    const currentSemantic=[...semantic].reverse().find(e=>e.type);
    const currentApp=currentSemantic?.app||current?.app||'music-suite';
    const currentType=currentSemantic?.type||null;
    const currentAdvanced=semantic.some(e=>e.app===currentApp&&advancement.has(e.type));
    const project=(window.MusicActivity&&window.MusicActivity.projectName)?window.MusicActivity.projectName():null;
    const appsUsed=apps.map(a=>labels[a]||a);
    const completedSteps=unique(semantic.filter(e=>e.type==='completed').map(e=>clean(e.detail)));
    const outputs=[];
    if(semantic.some(e=>e.app==='vocal-lab-v3'&&advancement.has(e.type)))outputs.push('メロディ／フレーズ');
    if(semantic.some(e=>e.app==='chord-lab'&&advancement.has(e.type)))outputs.push('コード進行');
    if(semantic.some(e=>e.app==='beat-lab'&&advancement.has(e.type)))outputs.push('ドラムパターン');
    if(semantic.some(e=>e.app==='canvas'&&advancement.has(e.type)))outputs.push('曲構成');
    if(semantic.some(e=>e.app==='score-editor-v2'&&advancement.has(e.type)))outputs.push('最終スコア／MIDI');
    let next={app:'music-suite',action:'review',label:'作った曲を振り返る',sourceRef:urls['music-suite']};
    if(currentApp==='vocal-lab-v3'){
      next=currentAdvanced
        ? {app:'canvas',action:'arrange',label:'フレーズをCanvasで構成する',sourceRef:urls.canvas}
        : {app:'vocal-lab-v3',action:'continue',label:'Vocal Labでフレーズ制作を続ける',sourceRef:urls['vocal-lab-v3']};
    }else if(currentApp==='canvas'){
      next=currentAdvanced
        ? {app:'score-editor-v2',action:'edit',label:'Score Editorで仕上げる',sourceRef:urls['score-editor-v2']}
        : {app:'canvas',action:'continue',label:'Canvasで曲構成を続ける',sourceRef:urls.canvas};
    }else if(currentApp==='chord-lab'||currentApp==='beat-lab'){
      next=currentAdvanced
        ? {app:'score-editor-v2',action:'edit',label:'Score Editorへ送って編曲する',sourceRef:urls['score-editor-v2']}
        : {app:currentApp,action:'continue',label:`${labels[currentApp]}で制作を続ける`,sourceRef:urls[currentApp]};
    }else if(currentApp==='score-editor-v2'){
      next=currentAdvanced
        ? {app:'music-suite',action:'review',label:'完成した曲を振り返る',sourceRef:urls['music-suite']}
        : {app:'score-editor-v2',action:'continue',label:'Score Editorで仕上げを続ける',sourceRef:urls['score-editor-v2']};
    }
    const sourceRef=urls[currentApp]||urls['music-suite'];
    const status=currentSemantic?currentSemantic.type:'opened';
    const activity={
      app:APP,
      stage:current?current.stage:'plan',
      stageLabel:stageLabels[current?current.stage:'plan'],
      projectName:project,
      sourceAction:currentSemantic?clean(currentSemantic.detail):(current?clean(current.action):'music-suite production'),
      sourceRef,
      appsUsed,
      completedSteps,
      outputs,
      currentStatus:status,
      canAdvance:currentAdvanced,
      semanticEvents:semantic.slice(-30).map(e=>({at:e.at,app:e.app,stage:e.stage,type:e.type,detail:clean(e.detail)})),
      actions:events.map(e=>clean(e.action||e.detail)).filter(Boolean).slice(-20),
      status:'recorded',
      summary:project?`${project}：${appsUsed.length?appsUsed.join(' → '):'music-suite'} の制作状況を記録しました。`:`${appsUsed.length?appsUsed.join(' → '):'music-suite'} の制作状況を記録しました。`
    };
    return {
      protocol:'hub_handoff_v1',
      id:crypto.randomUUID(),
      createdAt:new Date().toISOString(),
      source:APP,
      sourceRef,
      intent:'music.review',
      context:{text:activity.summary,tags:['music','production'].concat(apps),emotion:null,focus:'review'},
      payload:{stage:activity.stage,status:'recorded',activity,nextAction:next.action,message:currentAdvanced?'制作結果を確認し、次の工程へ進めます。':'まだ制作途中です。まず現在の専門アプリで作業を続けます。',recommendation:next},
      next:{app:'flow-hub',action:'review'},
      returnTo:'https://norinori-jan.github.io/flow-hub/'
    };
  }
  window.MusicActivityHandoff={build};
})();
