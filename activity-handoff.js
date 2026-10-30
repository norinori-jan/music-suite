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
    'score-editor-v2':'https://norinori-jan.github.io/music-suite/apps/score-editor-v2.html',
    'compose-spark':'https://norinori-jan.github.io/music-suite/apps/compose-spark.html'
  };
  const labels={'vocal-lab-v3':'Vocal Lab','canvas':'Canvas','chord-lab':'Chord Lab','beat-lab':'Beat Lab','score-editor-v2':'Score Editor','music-suite':'music-suite','compose-spark':'ひらめき'};
  const stageLabels={capture:'素材・メロディ',compose:'作曲',arrange:'構成・アレンジ',produce:'最終編集・出力',plan:'制作計画'};
  // 「保存した」だけでは次工程へ進めない。制作上の到達点を completed/sent/exported として扱う。
  const advancement=new Set(['exported','completed','sent']);
  function read(){try{return JSON.parse(localStorage.getItem(SESSION)||'[]')}catch(e){return[]}}
  function clean(v){return String(v||'').replace(/\s+/g,' ').trim().slice(0,120)}
  function unique(a){return [...new Set(a.filter(Boolean))]}
  function advancedFor(semantic,app){return semantic.some(e=>e.app===app&&advancement.has(e.type))}
  function build(){
    const events=read();
    const apps=unique(events.map(e=>e.app));
    const current=events.length?events[events.length-1]:null;
    const semantic=events.filter(e=>e.kind==='semantic');
    const currentSemantic=[...semantic].reverse().find(e=>e.type);
    const currentApp=currentSemantic?.app||current?.app||'music-suite';
    const currentType=currentSemantic?.type||null;
    const currentAdvanced=advancedFor(semantic,currentApp);
    const project=(window.MusicActivity&&window.MusicActivity.projectName)?window.MusicActivity.projectName():null;
    const appsUsed=apps.map(a=>labels[a]||a);
    const productionPath=appsUsed;
    const completedSteps=unique(semantic.filter(e=>e.type==='completed'||e.type==='sent').map(e=>clean(e.detail)));
    const outputs=[];
    if(advancedFor(semantic,'vocal-lab-v3'))outputs.push('メロディ／フレーズ');
    if(advancedFor(semantic,'chord-lab'))outputs.push('コード進行');
    if(advancedFor(semantic,'compose-spark'))outputs.push('コード進行・メロディ案');
    if(advancedFor(semantic,'beat-lab'))outputs.push('ドラムパターン');
    if(advancedFor(semantic,'canvas'))outputs.push('曲構成');
    if(advancedFor(semantic,'score-editor-v2'))outputs.push('最終スコア／MIDI');

    let next={app:'music-suite',action:'review',label:'作った曲を振り返る',sourceRef:urls['music-suite']};
    let nextMessage='制作結果を確認し、次の工程へ進めます。';
    if(currentApp==='vocal-lab-v3'){
      next=currentAdvanced
        ? {app:'canvas',action:'arrange',label:'フレーズをCanvasで構成する',sourceRef:urls.canvas}
        : {app:'vocal-lab-v3',action:'continue',label:'Vocal Labでフレーズ制作を続ける',sourceRef:urls['vocal-lab-v3']};
      nextMessage=currentAdvanced?'フレーズの到達点を確認しました。次は曲構成です。':'フレーズはまだ制作途中です。まずVocal Labで続けます。';
    }else if(currentApp==='canvas'){
      next=currentAdvanced
        ? {app:'score-editor-v2',action:'edit',label:'Score Editorで仕上げる',sourceRef:urls['score-editor-v2']}
        : {app:'canvas',action:'continue',label:'Canvasで曲構成を続ける',sourceRef:urls.canvas};
      nextMessage=currentAdvanced?'曲構成の到達点を確認しました。次はScore Editorです。':'曲構成はまだ途中です。まずCanvasで続けます。';
    }else if(currentApp==='chord-lab'||currentApp==='beat-lab'||currentApp==='compose-spark'){
      next=currentAdvanced
        ? {app:'score-editor-v2',action:'edit',label:'Score Editorへ送って編曲する',sourceRef:urls['score-editor-v2']}
        : {app:currentApp,action:'continue',label:`${labels[currentApp]}で制作を続ける`,sourceRef:urls[currentApp]};
      nextMessage=currentAdvanced?'素材の到達点を確認しました。Score Editorへ進めます。':`${labels[currentApp]}はまだ制作途中です。まず現在のアプリで続けます。`;
    }else if(currentApp==='score-editor-v2'){
      if(currentType==='exported'){
        next={app:'music-suite',action:'review',label:'完成した曲を振り返る',sourceRef:urls['music-suite']};
        nextMessage='MIDI／最終出力まで完了しました。制作実績を振り返れます。';
      }else if(currentType==='completed'){
        next={app:'score-editor-v2',action:'export',label:'MIDIを書き出す',sourceRef:urls['score-editor-v2']};
        nextMessage='曲の完成を確認しました。次はMIDI出力です。';
      }else{
        next={app:'score-editor-v2',action:'continue',label:'Score Editorで仕上げを続ける',sourceRef:urls['score-editor-v2']};
        nextMessage='Score Editorはまだ制作途中です。仕上げを続けます。';
      }
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
      productionPath,
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
      payload:{stage:activity.stage,status:'recorded',activity,nextAction:next.action,message:nextMessage,recommendation:next},
      next:{app:'flow-hub',action:'review'},
      returnTo:'https://norinori-jan.github.io/flow-hub/'
    };
  }
  window.MusicActivityHandoff={build};
})();
