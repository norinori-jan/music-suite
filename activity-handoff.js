// Build a hub_handoff_v1 activity payload from the current music-suite session.
(function(){
  const APP='music-suite';
  const SESSION='msuite_activity_session_v1';
  const urls={
    'music-suite':'https://norinori-jan.github.io/music-suite/',
    'vocal-lab-v3':'https://norinori-jan.github.io/music-suite/apps/vocal-lab-v3.html',
    'canvas':'https://norinori-jan.github.io/music-suite/apps/canvas.html',
    'composition-canvas':'https://norinori-jan.github.io/music-suite/apps/composition-canvas.html',
    'chord-lab':'https://norinori-jan.github.io/music-suite/apps/chord-lab.html',
    'beat-lab':'https://norinori-jan.github.io/music-suite/apps/beat-lab.html',
    'score-editor-v2':'https://norinori-jan.github.io/music-suite/apps/score-editor-v2.html'
  };
  const labels={'vocal-lab-v3':'Vocal Lab','canvas':'Canvas','composition-canvas':'Composition Canvas','chord-lab':'Chord Lab','beat-lab':'Beat Lab','score-editor-v2':'Score Editor','music-suite':'music-suite'};
  const stageLabels={capture:'素材・メロディ',compose:'作曲',arrange:'構成・アレンジ',produce:'最終編集・出力',plan:'制作計画'};
  function read(){try{return JSON.parse(localStorage.getItem(SESSION)||'[]')}catch(e){return[]}}
  function clean(v){return String(v||'').replace(/\s+/g,' ').trim().slice(0,120)}
  function unique(a){return [...new Set(a.filter(Boolean))]}
  function build(){
    const events=read();
    const apps=unique(events.map(e=>e.app));
    const current=events.length?events[events.length-1]:null;
    const project=(window.MusicActivity&&window.MusicActivity.projectName)?window.MusicActivity.projectName():null;
    const appsUsed=apps.map(a=>labels[a]||a);
    const completedSteps=unique(apps.filter(a=>a!=='music-suite').map(a=>labels[a]||a));
    const actions=events.map(e=>clean(e.action)).filter(Boolean);
    const outputs=[];
    if(apps.includes('vocal-lab-v3'))outputs.push('メロディ／フレーズ');
    if(apps.includes('chord-lab'))outputs.push('コード進行');
    if(apps.includes('beat-lab'))outputs.push('ドラムパターン');
    if(apps.includes('canvas')||apps.includes('composition-canvas'))outputs.push('曲構成');
    if(apps.includes('score-editor-v2'))outputs.push('最終スコア／MIDI');
    let next={app:'music-suite',action:'review',label:'作った曲を振り返る'};
    if(current&&current.app==='vocal-lab-v3')next={app:'music-suite',action:'arrange',label:'フレーズをCanvasで構成する'};
    else if(current&&(current.app==='canvas'||current.app==='composition-canvas'))next={app:'music-suite',action:'edit',label:'Score Editorで仕上げる'};
    else if(current&&(current.app==='chord-lab'||current.app==='beat-lab'))next={app:'music-suite',action:'edit',label:'Score Editorへ送って編曲する'};
    else if(current&&current.app==='score-editor-v2')next={app:'music-suite',action:'review',label:'完成した曲を振り返る'};
    const activity={
      app:APP,
      stage:current?current.stage:'plan',
      stageLabel:stageLabels[current?current.stage:'plan'],
      projectName:project,
      sourceAction:current?clean(current.action):'music-suite production',
      appsUsed,
      completedSteps,
      outputs,
      actions:actions.slice(-20),
      summary:project?(completedSteps.length?`${project}：${completedSteps.join(' → ')} を操作しました。`:`${project}の制作を開始しました。`):(completedSteps.length?`${completedSteps.join(' → ')} を操作しました。`:'music-suiteで制作を開始しました。')
    };
    const sourceRef=current&&urls[current.app]||urls['music-suite'];
    return {
      protocol:'hub_handoff_v1',
      id:crypto.randomUUID(),
      createdAt:new Date().toISOString(),
      source:APP,
      sourceRef,
      intent:'music.review',
      context:{text:activity.summary,tags:['music','production'].concat(apps),emotion:null,focus:'review'},
      payload:{stage:activity.stage,status:'completed',activity,nextAction:next.action,message:'music-suiteでの制作内容を確認し、次の工程を選べます。',recommendation:{...next,sourceRef}},
      next:{app:'flow-hub',action:'review'},
      returnTo:'https://norinori-jan.github.io/flow-hub/'
    };
  }
  window.MusicActivityHandoff={build};
})();
