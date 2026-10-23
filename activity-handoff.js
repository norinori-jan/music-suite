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
  function read(){try{return JSON.parse(localStorage.getItem(SESSION)||'[]')}catch(e){return[]}}
  function clean(v){return String(v||'').replace(/\s+/g,' ').trim().slice(0,120)}
  function unique(a){return [...new Set(a.filter(Boolean))]}
  function build(){
    const events=read();
    const apps=unique(events.map(e=>e.app));
    const current=events.length?events[events.length-1]:null;
    const project=(window.MusicActivity&&window.MusicActivity.projectName)?window.MusicActivity.projectName():null;
    const appsUsed=apps.map(a=>labels[a]||a);
    const actions=events.map(e=>clean(e.action)).filter(Boolean);
    const completionWords=/保存|書き出し|出力|エクスポート|export|save|送信|送る|確定|完成|完了/i;
    const completedActions=events.filter(e=>completionWords.test(clean(e.action)));
    const completedSteps=unique(completedActions.map(e=>clean(e.action)));
    const outputs=[];
    if(completedActions.some(e=>e.app==='vocal-lab-v3'))outputs.push('メロディ／フレーズ（保存・出力操作あり）');
    if(completedActions.some(e=>e.app==='chord-lab'))outputs.push('コード進行（保存・出力操作あり）');
    if(completedActions.some(e=>e.app==='beat-lab'))outputs.push('ドラムパターン（保存・出力操作あり）');
    if(completedActions.some(e=>e.app==='canvas'))outputs.push('曲構成（保存・出力操作あり）');
    if(completedActions.some(e=>e.app==='score-editor-v2'))outputs.push('最終スコア／MIDI（保存・出力操作あり）');
    let next={app:'music-suite',action:'review',label:'作った曲を振り返る',sourceRef:urls['music-suite']};
    if(current&&current.app==='vocal-lab-v3')next={app:'canvas',action:'arrange',label:'フレーズをCanvasで構成する',sourceRef:urls.canvas};
    else if(current&&current.app==='canvas')next={app:'score-editor-v2',action:'edit',label:'Score Editorで仕上げる',sourceRef:urls['score-editor-v2']};
    else if(current&&(current.app==='chord-lab'||current.app==='beat-lab'))next={app:'score-editor-v2',action:'edit',label:'Score Editorへ送って編曲する',sourceRef:urls['score-editor-v2']};
    else if(current&&current.app==='score-editor-v2')next={app:'music-suite',action:'review',label:'完成した曲を振り返る',sourceRef:urls['music-suite']};
    const sourceRef=current&&urls[current.app]||urls['music-suite'];
    const activity={
      app:APP,
      stage:current?current.stage:'plan',
      stageLabel:stageLabels[current?current.stage:'plan'],
      projectName:project,
      sourceAction:current?clean(current.action):'music-suite production',
      sourceRef,
      appsUsed,
      completedSteps,
      outputs,
      actions:actions.slice(-20),
      summary:project?`${project}：${appsUsed.length?appsUsed.join(' → '):'music-suite'} を操作しました。`:`${appsUsed.length?appsUsed.join(' → '):'music-suite'} を操作しました。`
    };
    return {
      protocol:'hub_handoff_v1',
      id:crypto.randomUUID(),
      createdAt:new Date().toISOString(),
      source:APP,
      sourceRef,
      intent:'music.review',
      context:{text:activity.summary,tags:['music','production'].concat(apps),emotion:null,focus:'review'},
      payload:{stage:activity.stage,status:'recorded',activity,nextAction:next.action,message:'music-suiteでの実際の操作内容を確認し、次の工程を選べます。',recommendation:next},
      next:{app:'flow-hub',action:'review'},
      returnTo:'https://norinori-jan.github.io/flow-hub/'
    };
  }
  window.MusicActivityHandoff={build};
})();
