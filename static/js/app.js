(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const all = selector => [...document.querySelectorAll(selector)];
  const clamp = (value, min, max, fallback = 0) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback;
  const frequencies = CivicDSP.frequencies;
  const frequencyLabel = f => f >= 1000 ? `${f / 1000}k` : `${f}`;
  const speakers = [
    {id:'tl',location:'L · Sail panel',position:'FRONT LEFT · SAIL PANEL',brand:'Rockford Fosgate',model:'P165-SI',size:'1″ tweeter',detail:'P165-SI · 1″ PEI tweeter',side:'L',band:'high',key:'highL'},
    {id:'tr',location:'R · Sail panel',position:'FRONT RIGHT · SAIL PANEL',brand:'Rockford Fosgate',model:'P165-SI',size:'1″ tweeter',detail:'P165-SI · 1″ PEI tweeter',side:'R',band:'high',key:'highR'},
    {id:'wl',location:'L · Lower door',position:'FRONT LEFT · LOWER DOOR',brand:'Rockford Fosgate',model:'P165-SI',size:'6.5″ woofer',detail:'P165-SI · 6.5″ component woofer',side:'L',band:'mid',key:'midL'},
    {id:'wr',location:'R · Lower door',position:'FRONT RIGHT · LOWER DOOR',brand:'Rockford Fosgate',model:'P165-SI',size:'6.5″ woofer',detail:'P165-SI · 6.5″ component woofer',side:'R',band:'mid',key:'midR'},
    {id:'rl',location:'L · Trunk enclosure',position:'REAR LEFT · ENCLOSURE FACE',brand:'Kicker',model:'CS',size:'6.5″ coaxial',detail:'CS · 6.5″ coaxial speaker',side:'L',band:'full',key:'fullL'},
    {id:'rr',location:'R · Trunk enclosure',position:'REAR RIGHT · ENCLOSURE FACE',brand:'Kicker',model:'CS',size:'6.5″ coaxial',detail:'CS · 6.5″ coaxial speaker',side:'R',band:'full',key:'fullR'},
    {id:'sub',position:'SUBWOOFER · TRUNK ENCLOSURE',brand:'Rockford Fosgate',model:'R2D4',detail:'R2D4 · 10″ dual voice coil subwoofer',side:'L+R',band:'low',key:'low'}
  ];
  const defaults = {gains:{highL:0,highR:0,midL:0,midR:0,fullL:0,fullR:0,low:0},eq:Array(31).fill(0),width:100,balance:0,volume:65,bypass:false};
  let state = structuredClone(defaults);
  try {
    const saved = JSON.parse(localStorage.getItem('civic-sound-v1') || 'null');
    if (saved && typeof saved === 'object') {
      Object.keys(state.gains).forEach(key => state.gains[key] = clamp(saved.gains?.[key],-24,0));
      state.eq = frequencies.map((_,i) => clamp(saved.eq?.[i],-12,12));
      state.width = clamp(saved.width,0,150,100); state.balance = clamp(saved.balance,-100,100);
      state.volume = clamp(saved.volume,0,100,65); state.bypass = saved.bypass === true;
    }
  } catch { /* Browser storage may be unavailable; use session defaults. */ }
  let selected = speakers[0], selectedEQ = 17, audition = false, muted = false, graph = null;
  let toastTimer, vizMode = 'spectrum', vizFrame = null, currentPage = 'sound', shuffle = false, repeat = false;
  let sourceMode = 'local', bluetoothStarting = false, restoreBluetooth = false, sourceChoiceResolved = false;
  try{restoreBluetooth=localStorage.getItem('civic-audio-source')==='bluetooth';}catch{}
  const cutRestore = {};
  const player = $('audio-player'), tracks = []; let trackIndex = -1, usbScanned = false, savingTrack = false, deletingTrack = false, deleteTarget = null;
  const icon = name => `<svg aria-hidden="true"><use href="#${name}-icon"/></svg>`;
  function toast(message) { $('toast').textContent = message; $('toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('visible'),4200); }
  function dirty() { $('profile-status').textContent = 'Save tuning'; }
  function fill(input) { input.style.setProperty('--fill', `${100 * (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))}%`); }
  function showPage(id) {
    if (!$(id)?.classList.contains('page')) return;
    currentPage = id;
    all('.page').forEach(p => {p.hidden = p.id !== id; p.classList.toggle('active',p.id === id);});
    all('.nav-btn').forEach(b => {const active = b.dataset.page === id || (['phone','visualizer'].includes(id) && b.dataset.page === 'apps'); b.classList.toggle('active',active); active ? b.setAttribute('aria-current','page') : b.removeAttribute('aria-current');});
    const titles = {sound:'Sound studio',home:'Overview',music:'Your music',phone:'Phone audio',lights:'Cabin lighting',vehicle:'Vehicle diagnostics',apps:'Applications',visualizer:'Visualizer'};
    $('page-title').textContent = titles[id];
    window.CivicDiagnostics?.setVisible(id==='vehicle');
    window.CivicLights?.setVisible(id==='lights');
    if (id === 'visualizer') startVisualizer(); else {cancelAnimationFrame(vizFrame); vizFrame = null;}
    if (id === 'music' && !usbScanned) {usbScanned = true; scanUSB(false);}
  }
  function showTab(id, focus = false) {
    all('.tab-content').forEach(p => {p.hidden = p.id !== id; p.classList.toggle('active',p.id === id);});
    all('.tab').forEach(b => {const active = b.dataset.tab === id; b.classList.toggle('active',active); b.setAttribute('aria-selected',String(active)); b.tabIndex = active ? 0 : -1; if (focus && active) b.focus();});
  }
  all('[data-page]').forEach(b => b.addEventListener('click',() => showPage(b.dataset.page)));
  all('[data-tab]').forEach(b => b.addEventListener('click',() => showTab(b.dataset.tab)));
  document.querySelector('.tabs').addEventListener('keydown', e => {const tabs = all('.tab'), i = tabs.indexOf(document.activeElement); let next;
    if (e.key === 'ArrowRight') next = (i+1)%tabs.length; if(e.key === 'ArrowLeft') next = (i+tabs.length-1)%tabs.length; if(e.key === 'Home') next = 0; if(e.key === 'End') next = tabs.length-1;
    if(next !== undefined){e.preventDefault(); showTab(tabs[next].dataset.tab,true);}
  });
  function clock() {$('clock').textContent = new Date().toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});} clock(); setInterval(clock,15000);
  // The map contains seven physical drivers; controls intentionally share source channels.
  speakers.forEach(s => {
    const b = document.createElement('button'); b.dataset.speaker = s.id; b.setAttribute('aria-label',`${s.position}: ${s.brand} ${s.detail}`);
    if(s.id === 'sub') {b.className = 'sub-label'; b.innerHTML = '<strong>Sub · R2D4</strong><span><b data-map-value="sub">0.0 dB</b></span>';}
    else {const labels={tl:'Left tweeter',tr:'Right tweeter',wl:'Left door',wr:'Right door',rl:'Left rear',rr:'Right rear'};b.className = `speaker-label sl-${s.id}`; b.innerHTML = `<span class="speaker-location">${labels[s.id]}</span><strong>${s.brand === 'Kicker' ? 'Kicker CS' : s.model} · ${s.size.split(' ')[0]}</strong><span class="map-value" data-map-value="${s.id}">0.0 dB</span>`;}
    b.addEventListener('click',() => {selected = s; audition = false; renderSpeaker(); updateDSP();}); $('speaker-labels').append(b);
  });
  function renderSpeaker() {
    const s = selected, gain = state.gains[s.key];
    all('[data-speaker]').forEach(b => {const active = b.dataset.speaker === s.id;b.classList.toggle('selected',active);b.setAttribute('aria-pressed',String(active));});
    all('[data-node]').forEach(n => n.classList.toggle('selected',n.dataset.node === s.id));
    speakers.forEach(s => {const el = document.querySelector(`[data-map-value="${s.id}"]`); el.textContent = `${state.gains[s.key].toFixed(1)} dB`;});
    $('speaker-position').textContent=s.position; $('speaker-name').textContent=s.brand; $('speaker-model').textContent=s.detail; $('channel-chip').textContent=s.side;
    $('gain-value').textContent=gain.toFixed(1); $('speaker-gain').value=gain; fill($('speaker-gain'));
    $('band-tag').textContent=`${{high:'TREBLE',mid:'MIDRANGE',low:'BASS',full:'FULL CHANNEL'}[s.band]} · ${s.side}`;
    $('frequency-region').textContent={high:'3.5 kHz and up',mid:'70 Hz – 3.5 kHz',low:'Below 70 Hz',full:'Full-range L/R source'}[s.band];
    $('slope-label').textContent=s.band === 'full' ? 'Shared source' : '12 dB/oct · LR2';
    $('curve-line').setAttribute('d',{high:'M3 29Q25 29 38 16T81 4',low:'M3 4Q25 4 38 16T81 29',mid:'M3 29Q15 29 23 10Q40-5 58 10Q67 29 81 29',full:'M3 8H81'}[s.band]);
    const side = s.side === 'L' ? 'left' : 'right';
    $('routing-note').textContent={high:`${side[0].toUpperCase()+side.slice(1)}-channel treble trim. Also affects the ${side} rear coaxial.`,mid:`${side[0].toUpperCase()+side.slice(1)}-channel midrange trim. Also affects the ${side} rear coaxial.`,low:'Bass trim on both HDMI channels. Also affects bass sent to the doors and rear coaxials.',full:`Full ${side} source level. Also changes the ${side} front components and the sub feed.`}[s.band];
    $('amp-name').textContent=s.band==='low'?'R2-250X1':s.band==='full'?'Kenwood DMX8710s':'R2-200X2';
    $('amp-location').textContent=s.band==='low'?'TRUNK · RIGHT RACK':s.band==='full'?'HEAD UNIT POWER':'TRUNK · LEFT RACK';
    $('amp-description').textContent=s.band==='low'?'10″ DVC sub · sealed enclosure · 70 Hz low-pass':s.band==='full'?'Rear coaxials · separate rear level at the Kenwood':'Front components · passive crossover at ~3.5 kHz';
    $('cut-band').classList.toggle('active',gain===-24); $('cut-band').setAttribute('aria-pressed',String(gain===-24)); $('cut-band').textContent=gain===-24?'Restore band':'Cut band';
    $('audition-band').classList.toggle('active',audition); $('audition-band').setAttribute('aria-pressed',String(audition));
    $('gain-down').disabled=gain<=-24; $('gain-up').disabled=gain>=0;
  }
  function setGain(value) {state.gains[selected.key]=clamp(value,-24,0); dirty(); renderSpeaker(); updateDSP();}
  $('gain-down').onclick=()=>setGain(state.gains[selected.key]-.5); $('gain-up').onclick=()=>setGain(state.gains[selected.key]+.5);
  $('speaker-gain').oninput=e=>setGain(e.target.value);
  $('cut-band').onclick=()=>{const key=selected.key;if(state.gains[key]===-24) setGain(cutRestore[key]??0);else{cutRestore[key]=state.gains[key];setGain(-24);}};
  $('audition-band').onclick=()=>{audition=!audition;renderSpeaker();updateDSP();if(audition)toast('Band audition active on the shared HDMI source. Click again to restore full-range playback.');};
  $('routing-info').onclick=()=>showTab('routing');
  function selectEQ(index) {selectedEQ=index; all('.eq-band').forEach((b,i)=>b.classList.toggle('selected',i===index)); $('eq-selected').textContent=frequencies[index]>=1000?`${frequencies[index]/1000} kHz`:`${frequencies[index]} Hz`; $('eq-value').textContent=`${state.eq[index].toFixed(1)} dB`; $('eq-down').disabled=state.eq[index]<=-12; $('eq-up').disabled=state.eq[index]>=12;}
  frequencies.forEach((f,i)=>{const band=document.createElement('div');band.className='eq-band'; const output=document.createElement('output');output.textContent=state.eq[i].toFixed(1);const input=document.createElement('input');input.type='range';input.min=-12;input.max=12;input.step=.5;input.value=state.eq[i];input.setAttribute('aria-label',`${f} Hz gain`);input.setAttribute('aria-orientation','vertical');const label=document.createElement('button');label.textContent=frequencyLabel(f);label.setAttribute('aria-label',`Select ${f} Hz`);input.onfocus=()=>selectEQ(i);input.oninput=()=>{selectEQ(i);setEQ(input.value);};label.onclick=()=>selectEQ(i);band.append(output,input,label);$('eq-bands').append(band);});
  function refreshEQ(){all('.eq-band').forEach((b,i)=>{b.querySelector('input').value=state.eq[i];b.querySelector('output').textContent=state.eq[i].toFixed(1);});selectEQ(selectedEQ);$('eq-bypass').classList.toggle('active',state.bypass);$('eq-bypass').setAttribute('aria-pressed',String(state.bypass));$('eq-bypass').textContent=state.bypass?'EQ bypassed':'Bypass EQ';}
  function setEQ(value){state.eq[selectedEQ]=clamp(value,-12,12);$('eq-preset').value='custom';dirty();refreshEQ();updateDSP();}
  $('eq-down').onclick=()=>setEQ(state.eq[selectedEQ]-.5);$('eq-up').onclick=()=>setEQ(state.eq[selectedEQ]+.5);
  $('eq-bypass').onclick=()=>{state.bypass=!state.bypass;dirty();refreshEQ();updateDSP();};
  $('eq-preset').onchange=e=>{const preset=e.target.value;if(preset==='custom')return;state.eq=frequencies.map(f=>preset==='warm'?(f<160?3:f>5000?-2:0):preset==='vocal'?(f>=500&&f<=3150?3:f<100?-2:0):preset==='night'?(f<100?2:f>6000?1:f>=400&&f<1500?-1:0):0);dirty();refreshEQ();updateDSP();};
  function renderStage(){ $('stereo-width').value=state.width;$('width-value').textContent=`${state.width}%`;$('balance').value=state.balance;$('balance-value').textContent=state.balance===0?'Center':`${Math.abs(state.balance)}% ${state.balance<0?'L':'R'}`;$('balance-marker').style.left=`${(state.balance+100)/2}%`;fill($('stereo-width'));fill($('balance'));}
  $('stereo-width').oninput=e=>{state.width=Number(e.target.value);dirty();renderStage();updateDSP();};$('balance').oninput=e=>{state.balance=Number(e.target.value);dirty();renderStage();updateDSP();};
  $('width-reset').onclick=()=>{state.width=100;dirty();renderStage();updateDSP();};$('balance-reset').onclick=()=>{state.balance=0;dirty();renderStage();updateDSP();};
  $('save-profile').onclick=()=>{try{localStorage.setItem('civic-sound-v1',JSON.stringify(state));$('profile-status').textContent='Tuning saved';toast('Tuning saved on this device.');}catch{toast('Browser storage is unavailable. Tuning will last for this session.');}};
  // Local media and Bluetooth PCM enter the same graph, before headroom/EQ.
  async function ensureAudio(){
    if(graph){await resumeAudio(graph.ctx);return;}
    const ctx=new AudioContext({sampleRate:48000,latencyHint:'interactive'});const source=ctx.createMediaElementSource(player),localGain=ctx.createGain(),headroom=ctx.createGain();headroom.gain.value=0;headroom.channelCount=2;headroom.channelCountMode='explicit';source.connect(localGain);localGain.connect(headroom);
    let tail=headroom;const eq=frequencies.map(f=>{const node=ctx.createBiquadFilter();node.type='peaking';node.frequency.value=Math.min(f,ctx.sampleRate*.499);node.Q.value=4.318;tail.connect(node);tail=node;return node;});
    const split=ctx.createChannelSplitter(2),merge=ctx.createChannelMerger(2);tail.connect(split);
    // Mid/side matrix: L'=(1+w)L/2+(1-w)R/2, R'=(1-w)L/2+(1+w)R/2.
    const matrix=Array.from({length:4},()=>ctx.createGain());const leftSum=ctx.createGain(),rightSum=ctx.createGain();
    split.connect(matrix[0],0);split.connect(matrix[1],1);split.connect(matrix[2],0);split.connect(matrix[3],1);matrix[0].connect(leftSum);matrix[1].connect(leftSum);matrix[2].connect(rightSum);matrix[3].connect(rightSum);
    const channels=[leftSum,rightSum].map((sum,i)=>{
      const level=ctx.createGain();const bands=CivicDSP.createBands(ctx,sum,level);level.connect(merge,0,i);
      return {...bands,level};
    });
    const guard=ctx.createDynamicsCompressor();guard.threshold.value=-1;guard.knee.value=0;guard.ratio.value=20;guard.attack.value=.003;guard.release.value=.1;
    // Cancel Chromium's automatic compressor makeup gain for this hard-knee curve.
    // The guard remains active, without adding gain below its threshold.
    const guardUnity=ctx.createGain();guardUnity.gain.value=10**(.6*guard.threshold.value*(1-1/guard.ratio.value)/20);
    const volume=ctx.createGain(),analyser=ctx.createAnalyser();analyser.fftSize=2048;merge.connect(guard);guard.connect(guardUnity);guardUnity.connect(volume);volume.connect(analyser);analyser.connect(ctx.destination);
    graph={ctx,eq,matrix,channels,volume,analyser,input:headroom,headroom,localGain};updateDSP();await resumeAudio(ctx);
  }
  async function resumeAudio(ctx){
    await Promise.race([ctx.resume(),new Promise(resolve=>setTimeout(resolve,1200))]);
    if(ctx.state!=='running')throw new Error('Tap Use Bluetooth to enable audio.');
  }
  const bluetooth=new CivicBluetooth(info=>{
    if(!sourceChoiceResolved&&typeof info.enabled==='boolean'){
      sourceChoiceResolved=true;
      if(info.preferred_source==='bluetooth')restoreBluetooth=true;
      if(info.preferred_source==='local')restoreBluetooth=false;
    }
    const selected=info.selected;
    $('bluetooth-state').textContent=info.error||(!info.enabled?'Bluetooth bridge not enabled':!info.ready?'Preparing Pi audio…':!info.connected?'Waiting for your iPhone':selected&&info.active?info.playing?'Bluetooth · DSP active':'Connected · playback paused':'iPhone connected · select Use Bluetooth');
    $('bluetooth-badge').textContent=info.connected?(info.active?'DSP active':'iPhone connected'):'Not connected';
    $('bluetooth-state').classList.toggle('is-live',selected&&info.active);
    $('use-bluetooth').disabled=bluetoothStarting||!info.ready;
    $('use-bluetooth').textContent=bluetoothStarting?'Starting…':selected?'Reconnect Bluetooth':'Use Bluetooth';
    $('use-local').classList.toggle('active',!selected);
    $('output-source').textContent=selected?'BLUETOOTH':'LOCAL';
    if(selected){$('track-title').textContent='Bluetooth audio';$('track-subtitle').textContent='iPhone · 31-band EQ + DSP';$('viz-track').textContent='iPhone · Bluetooth';}
    ['play','next','previous','shuffle','repeat'].forEach(id=>{$(id).disabled=selected;$(id).title=selected?'Use playback controls on your iPhone':'';});
    if(selected){$('seek').disabled=true;$('seek').value=0;fill($('seek'));$('elapsed').textContent='LIVE';$('duration').textContent='—';}
    if(restoreBluetooth&&info.ready){restoreBluetooth=false;useBluetooth();}
  });
  function rememberSource(source){
    try{localStorage.setItem('civic-audio-source',source);}catch{}
    if(location.protocol==='file:')return;
    fetch('/api/bluetooth/source',{method:'POST',headers:{'Content-Type':'application/json','X-Civic-Request':'1'},body:JSON.stringify({source})})
      .then(response=>{if(!response.ok)throw new Error();})
      .catch(()=>toast('Audio source changed, but it could not be saved for startup.'));
  }
  async function useBluetooth(){
    if(bluetoothStarting)return;bluetoothStarting=true;$('use-bluetooth').disabled=true;
    try{
      await ensureAudio();player.pause();
      await bluetooth.start(graph.ctx,graph.input);
      graph.localGain.gain.value=0;sourceMode='bluetooth';
      rememberSource('bluetooth');
      $('play').classList.remove('playing');$('play').innerHTML=icon('play');
      toast('Bluetooth now uses the EQ, source-band trims, sound stage and visualizer.');
    }catch(error){bluetooth.stop();sourceMode='local';if(graph)graph.localGain.gain.value=1;toast(error.message||'Bluetooth audio could not start.');}
    finally{bluetoothStarting=false;bluetooth.notify();}
  }
  function useLocal(){
    restoreBluetooth=false;bluetooth.stop();sourceMode='local';if(graph)graph.localGain.gain.value=1;
    rememberSource('local');
    if(tracks[trackIndex])showTrackMetadata(tracks[trackIndex]);
    else{$('track-title').textContent='No track selected';$('track-subtitle').textContent='Choose USB or onboard music';$('viz-track').textContent='Awaiting playback';}
    $('seek').disabled=!Number.isFinite(player.duration)||player.duration<=0;
    $('elapsed').textContent=timeLabel(player.currentTime);$('duration').textContent=timeLabel(player.duration);
  }
  $('use-bluetooth').onclick=useBluetooth;$('use-local').onclick=useLocal;
  function ramp(param,value){const now=graph.ctx.currentTime;param.cancelAndHoldAtTime(now);param.setTargetAtTime(value,now,.02);}
  function updateEQHeadroom(){
    const gains=state.eq.map(gain=>state.bypass?0:gain),key=gains.join(',');
    if(graph.eqKey===key)return;
    const result=CivicDSP.eqHeadroom(gains,graph.ctx.sampleRate);
    // Reserve for overlapping old/new filters while a preset or band changes.
    const previous=(graph.ctx.currentTime<(graph.eqHoldUntil||0)?graph.eqEnvelope:graph.eqGains)||Array(31).fill(0);
    const envelope=gains.map((gain,i)=>Math.max(gain,previous[i]));
    const transition=CivicDSP.eqHeadroom(envelope,graph.ctx.sampleRate);
    const now=graph.ctx.currentTime,param=graph.headroom.gain;
    param.cancelAndHoldAtTime(now);
    param.setTargetAtTime(Math.min(param.value,transition.gain),now,.003);
    param.setTargetAtTime(result.gain,now+.2,.15);
    graph.eq.forEach((node,i)=>{node.gain.cancelAndHoldAtTime(now);node.gain.setTargetAtTime(gains[i],now+.02,.02);});
    graph.eqGains=gains;graph.eqEnvelope=envelope;graph.eqHoldUntil=now+.25;graph.eqKey=key;
    $('eq-headroom').textContent=`Auto headroom: ${result.attenuationDB?`−${result.attenuationDB.toFixed(1)}`:'0.0'} dB · peak guard`;
  }
  function updateDSP(){if(!graph)return;const w=state.width/100;const norm=Math.max(1,w);[ (1+w)/2,(1-w)/2,(1-w)/2,(1+w)/2 ].forEach((value,i)=>ramp(graph.matrix[i].gain,value/norm));
    updateEQHeadroom();
    graph.channels.forEach((c,i)=>{const side=i?'R':'L';
      ['low','mid','high'].forEach(band=>{const enabled=!audition||selected.band==='full'||selected.band===band;const db=state.gains[band==='low'?'low':`${band}${side}`];ramp(c[band].gain,enabled?(band==='mid'?-1:1)*10**(db/20):0);});
      const balance=state.balance/100;let gain=10**(state.gains[`full${side}`]/20)*(i===0?1-Math.max(0,balance):1+Math.min(0,balance));
      if(audition&&selected.side!=='L+R'&&selected.side!==side)gain=0;ramp(c.level.gain,gain);
    });ramp(graph.volume.gain,muted?0:(state.volume/100)**2);
  }
  function renderVolume(){$('master-volume').value=state.volume;$('volume-value').textContent=muted?'0':String(state.volume);fill($('master-volume'));$('master-mute').classList.toggle('active',muted);$('master-mute').setAttribute('aria-pressed',String(muted));$('master-mute').setAttribute('aria-label',muted?'Unmute':'Mute');}
  $('master-volume').oninput=e=>{state.volume=Number(e.target.value);muted=false;dirty();renderVolume();updateDSP();};$('master-mute').onclick=()=>{muted=!muted;renderVolume();updateDSP();};
  function chooseFiles(){$('music-files').click();} all('.choose-files').forEach(b=>b.onclick=chooseFiles);
  function renderLibrary(){const list=$('track-list');list.replaceChildren();const query=$('library-search').value.toLowerCase();$('track-count').textContent=`${tracks.length} ${tracks.length===1?'track':'tracks'}`;
    if(!tracks.length){list.innerHTML=`<div class="empty-library">${icon('music')}<h3>No music loaded</h3><p>Add MP3, FLAC, WAV or other browser-supported audio.</p><button class="outline-btn choose-files">Choose music</button></div>`;list.querySelector('button').onclick=chooseFiles;return;}
    tracks.forEach((track,i)=>{if(!`${track.title} ${track.artist}`.toLowerCase().includes(query))return;const b=document.createElement('button');b.className=`track-row${i===trackIndex?' active':''}`;if(track.id)b.dataset.trackId=track.id;const n=document.createElement('span');n.textContent=String(i+1).padStart(2,'0');const title=document.createElement('strong');title.textContent=track.title;const ext=document.createElement('small');ext.textContent=`${track.format} · ${track.origin==='onboard'?'PI':track.origin==='usb'?'USB':'LOCAL'}`;b.append(n,title,ext);b.onclick=()=>loadTrack(i,true);const row=document.createElement('div');row.className='track-entry';row.append(b);if(track.origin==='onboard'&&track.delete_token){const remove=document.createElement('button');remove.className='delete-track';remove.textContent='Delete';remove.setAttribute('aria-label',`Delete ${track.title} from Pi`);remove.disabled=savingTrack||deletingTrack;remove.onclick=()=>confirmDeleteTrack(track);row.append(remove);}list.append(row);});if(!list.childElementCount){const p=document.createElement('p');p.className='system-note';p.textContent='No matching tracks.';list.append(p);}
  }
  $('library-search').oninput=renderLibrary;
  $('music-files').onchange=async e=>{const files=[...e.target.files];if(!files.length)return;const first=tracks.length;files.forEach(file=>tracks.push({file,origin:'local',format:file.name.split('.').pop().toUpperCase(),url:URL.createObjectURL(file),title:file.name.replace(/\.[^.]+$/,''),artist:'Local audio'}));renderLibrary();e.target.value='';await loadTrack(first,true);};
  async function scanUSB(notify=true){
    const button=$('scan-usb');if(button.disabled)return;button.disabled=true;button.textContent='Scanning…';$('usb-status').textContent='Looking for music on mounted storage…';
    try{
      const response=await fetch('/api/library',{cache:'no-store'});if(!response.ok)throw new Error(response.status===409?'A USB scan is already running. Try again shortly.':'USB scanning requires the Flask backend.');
      const data=await response.json();if(!Array.isArray(data.tracks))throw new Error('Invalid USB library response.');
      const previous=tracks[trackIndex],old=new Map(tracks.filter(t=>t.origin!=='local').map(t=>[t.id,t]));
      const indexed=data.tracks.map(t=>{const prior=old.get(t.id);return prior&&prior.delete_token===t.delete_token?prior:{...t,origin:t.origin||'usb'};}),local=tracks.filter(t=>t.origin==='local');
      const retained=new Set(indexed.map(t=>t.id));old.forEach(t=>{if(!retained.has(t.id)&&t.artwork)URL.revokeObjectURL(t.artwork);});
      tracks.splice(0,tracks.length,...local,...indexed);trackIndex=previous?tracks.indexOf(previous):-1;
      if(previous&&trackIndex<0){player.pause();player.removeAttribute('src');player.load();$('track-title').textContent='Music file unavailable';$('track-subtitle').textContent='Check your storage and scan again';}
      const onboard=indexed.filter(t=>t.origin==='onboard').length,usb=indexed.length-onboard;
      const message=indexed.length?`${onboard} onboard · ${usb} USB ${usb===1?'track':'tracks'}${data.truncated?' · library limit reached':''}${data.inaccessible?' · some folders unreadable':''}`:'Your library is empty. Add music or connect a USB drive.';
      $('usb-status').textContent=message;renderLibrary();renderSaveButton();if(notify)toast(message);
    }catch(error){const message=location.protocol==='file:'?'Run Flask for onboard storage and USB discovery.':error.message;$('usb-status').textContent=message;if(notify)toast(message);}
    finally{button.disabled=false;button.innerHTML=`${icon('folder')}Scan USB`;}
  }
  $('scan-usb').onclick=()=>scanUSB();
  function renderSaveButton(){
    const track=tracks[trackIndex],saved=track?.origin==='onboard'||!!track?.savedOnboardId;
    $('save-onboard').disabled=savingTrack||deletingTrack||!track||saved||location.protocol==='file:';
    $('save-onboard').textContent=savingTrack?'Saving…':saved?'Saved on Pi':'Save to Pi';
    $('save-onboard').classList.toggle('is-saved',saved);
    $('storage-caption').textContent=track?.origin==='onboard'?'Stored onboard · USB drive not needed':saved?'An onboard copy is saved':track?.origin==='usb'?'Playing from USB · save a copy to keep it onboard':track?'Playing from this device · not yet stored on the Pi':'Save your tracks for playback without a USB drive';
    if(location.protocol==='file:')$('storage-caption').textContent='Run the Flask dashboard to save music onboard';
  }
  $('save-onboard').onclick=async()=>{
    const source=tracks[trackIndex];if(!source||savingTrack||source.origin==='onboard')return;
    savingTrack=true;renderSaveButton();
    try{
      const headers={'X-Civic-Request':'1'};let body;
      if(source.file){body=new FormData();body.append('file',source.file,source.file.name);}else{headers['Content-Type']='application/json';body=JSON.stringify({track_id:source.id});}
      const response=await fetch('/api/library/import',{method:'POST',headers,body});
      const data=await response.json().catch(()=>({error:'The copy could not be completed.'}));if(!response.ok)throw new Error(data.error||'The copy could not be completed.');
      let saved=tracks.find(t=>t.id===data.track.id);
      if(!saved){saved={...data.track,title:source.title,artist:source.artist,album:source.album};tracks.push(saved);}
      source.savedOnboardId=saved.id;
      // Switch the selected track to the durable copy so removing the USB is safe.
      if(tracks[trackIndex]===source){const position=player.currentTime,playing=!player.paused;player.addEventListener('loadedmetadata',()=>{if(tracks[trackIndex]===saved&&Number.isFinite(player.duration))player.currentTime=Math.min(position,player.duration);},{once:true});await loadTrack(tracks.indexOf(saved),playing);}
      await scanUSB(false);toast(data.already_saved?'This track is already saved on the Pi.':'Saved on the Pi. Your original file is unchanged.');
    }catch(error){toast(error.message||'Could not save this track. Check onboard storage and try again.');}
    finally{savingTrack=false;renderSaveButton();renderLibrary();}
  };
  function confirmDeleteTrack(track){
    if(deletingTrack||savingTrack||track.origin!=='onboard'||!track.delete_token)return;
    deleteTarget={track,token:track.delete_token};
    $('delete-music-name').textContent=track.title;
    $('delete-music-playing').hidden=tracks[trackIndex]!==track||sourceMode!=='local'||player.paused;
    $('delete-music-error').hidden=true;
    $('delete-music-dialog').showModal();
  }
  $('cancel-delete-music').onclick=()=>{if(!deletingTrack){deleteTarget=null;$('delete-music-dialog').close();}};
  $('delete-music-dialog').addEventListener('cancel',event=>{if(deletingTrack)event.preventDefault();else deleteTarget=null;});
  $('confirm-delete-music').onclick=async()=>{
    if(deletingTrack||!deleteTarget)return;
    const {track,token}=deleteTarget;
    deletingTrack=true;$('confirm-delete-music').disabled=true;$('cancel-delete-music').disabled=true;
    $('confirm-delete-music').textContent='Deleting…';renderSaveButton();renderLibrary();
    try{
      const response=await fetch(`/api/library/${encodeURIComponent(track.id)}`,{method:'DELETE',headers:{'Content-Type':'application/json','X-Civic-Request':'1'},body:JSON.stringify({confirm:true,delete_token:token})});
      const result=await response.json();if(!response.ok||result.deleted!==true)throw new Error(result.error||'Could not delete this file.');
      const selected=tracks[trackIndex],wasSelected=selected===track;
      if(wasSelected){
        player.pause();player.removeAttribute('src');player.load();
        $('media-title').textContent='No track selected';$('media-subtitle').textContent='Choose music from your library.';
        document.querySelector('.album-art img')?.remove();document.querySelector('.mini-cover').style.backgroundImage='';document.querySelector('.mini-cover').classList.remove('has-art');
        if(sourceMode==='local'){$('track-title').textContent='No track selected';$('track-subtitle').textContent='Choose music from your library';$('viz-track').textContent='Awaiting playback';$('seek').value=0;$('seek').disabled=true;fill($('seek'));}
      }
      const index=tracks.indexOf(track);if(index>=0)tracks.splice(index,1);
      tracks.forEach(t=>{if(t.savedOnboardId===track.id)delete t.savedOnboardId;});
      if(track.artwork)URL.revokeObjectURL(track.artwork);
      trackIndex=wasSelected?-1:selected?tracks.indexOf(selected):-1;
      deleteTarget=null;$('delete-music-dialog').close();
      const onboard=tracks.filter(t=>t.origin==='onboard').length,usb=tracks.filter(t=>t.origin==='usb').length;
      $('usb-status').textContent=`${onboard} onboard · ${usb} USB tracks`;
      toast('Saved copy deleted from the Pi.');
    }catch(error){$('delete-music-error').textContent=error.message||'Could not delete this file.';$('delete-music-error').hidden=false;}
    finally{deletingTrack=false;$('confirm-delete-music').disabled=false;$('cancel-delete-music').disabled=false;$('confirm-delete-music').textContent='Delete file';renderLibrary();renderSaveButton();}
  };
  function showTrackMetadata(t){
    if(sourceMode==='local'){$('track-title').textContent=t.title;$('viz-track').textContent=t.title;}
    $('media-title').textContent=t.title;
    if(sourceMode==='local')$('track-subtitle').textContent=`${t.artist} · ${t.format}`;
    $('media-subtitle').textContent=t.album?`${t.artist} · ${t.album}`:'Local file · stereo DSP enabled';
    const art=document.querySelector('.album-art');art.querySelector('img')?.remove();
    const cover=document.querySelector('.mini-cover');cover.style.backgroundImage=t.artwork?`url("${t.artwork}")`:'';cover.classList.toggle('has-art',!!t.artwork);
    if(t.artwork){const img=document.createElement('img');img.src=t.artwork;img.alt=t.album?`${t.album} cover`:'Embedded album artwork';art.append(img);}
    renderSaveButton();
  }
  async function loadTrack(i,play=false){if(!tracks[i])return;useLocal();trackIndex=i;const t=tracks[i];player.src=t.url;showTrackMetadata(t);$('seek').value=0;$('seek').disabled=true;fill($('seek'));renderLibrary();
    if(!t.metadataRead){t.metadataRead=true;const metadataFile=t.file?Promise.resolve(t.file):fetch(t.metadata_url,{headers:{Range:'bytes=0-4194303'}}).then(response=>{if(!response.ok)throw new Error('Metadata unavailable');return response.blob();});metadataFile.then(file=>CivicMetadata(file)).then(meta=>{Object.assign(t,meta);if(tracks[trackIndex]===t)showTrackMetadata(t);renderLibrary();}).catch(()=>{});}
    if(play)await playTrack();}
  async function playTrack(){if(!tracks.length){chooseFiles();return;}if(trackIndex<0){await loadTrack(0,false);}try{await ensureAudio();await player.play();}catch(error){toast(error.name==='NotSupportedError'?'This audio format is not supported by this browser. Try FLAC, WAV or MP3.':'Playback could not start. Choose a supported local track and press play.');}}
  $('play').onclick=()=>player.paused?playTrack():player.pause();
  function advance(direction=1,ended=false){if(!tracks.length)return;if(direction<0&&player.currentTime>3){player.currentTime=0;return;}let next=trackIndex+direction;if(shuffle&&tracks.length>1){do{next=Math.floor(Math.random()*tracks.length);}while(next===trackIndex);}if(ended&&!repeat&&!shuffle&&next>=tracks.length)return;loadTrack((next+tracks.length)%tracks.length,true);}
  $('next').onclick=()=>advance();$('previous').onclick=()=>advance(-1);player.onended=()=>advance(1,true);
  $('shuffle').onclick=()=>{shuffle=!shuffle;$('shuffle').classList.toggle('active',shuffle);$('shuffle').setAttribute('aria-pressed',String(shuffle));};$('repeat').onclick=()=>{repeat=!repeat;$('repeat').classList.toggle('active',repeat);$('repeat').setAttribute('aria-pressed',String(repeat));toast(repeat?'Repeat playlist on':'Repeat playlist off');};
  player.onplay=()=>{$('play').classList.add('playing');$('play').setAttribute('aria-label','Pause');$('play').innerHTML=icon('pause');};player.onpause=()=>{$('play').classList.remove('playing');$('play').setAttribute('aria-label','Play');$('play').innerHTML=icon('play');};
  const timeLabel=t=>Number.isFinite(t)?`${Math.floor(t/60)}:${String(Math.floor(t%60)).padStart(2,'0')}`:'0:00';
  player.ondurationchange=()=>{$('duration').textContent=timeLabel(player.duration);$('seek').disabled=!Number.isFinite(player.duration)||player.duration<=0;};
  player.ontimeupdate=()=>{$('elapsed').textContent=timeLabel(player.currentTime);$('seek').value=Number.isFinite(player.duration)?player.currentTime/player.duration*100:0;fill($('seek'));};
  $('seek').oninput=e=>{if(Number.isFinite(player.duration))player.currentTime=Number(e.target.value)/100*player.duration;};
  player.onerror=()=>toast(tracks[trackIndex]?.origin==='usb'?'Unable to play this USB file. Check the drive, scan again, or try another track.':tracks[trackIndex]?.origin==='onboard'?'Unable to play this onboard file. Check storage or try another track.':'Unable to read this file. The format may not be supported by Chromium.');
  all('[data-viz]').forEach(b=>b.onclick=()=>{vizMode=b.dataset.viz;all('[data-viz]').forEach(x=>{const active=x===b;x.classList.toggle('active',active);x.setAttribute('aria-pressed',String(active));});$('viz-mode-label').textContent={spectrum:'FREQUENCY SPECTRUM',wave:'TIME-DOMAIN WAVEFORM',radial:'RADIAL SPECTRUM'}[vizMode];});
  function startVisualizer(){
    cancelAnimationFrame(vizFrame);const canvas=$('visualizer-canvas'),ctx=canvas.getContext('2d');
    const spectrum=new Uint8Array(1024),wave=new Uint8Array(2048);let previous=0;
    function draw(now=0){
      if(currentPage!=='visualizer')return;vizFrame=requestAnimationFrame(draw);if(now-previous<33)return;previous=now;
      if(document.hidden)return;
      const rect=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,1.5),w=rect.width,h=rect.height;
      if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}
      ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
      const playing=!!graph&&(sourceMode==='bluetooth'?bluetooth.playing:!player.paused);
      if(graph){graph.analyser.getByteFrequencyData(spectrum);graph.analyser.getByteTimeDomainData(wave);}else{wave.fill(128);spectrum.fill(0);}
      let rms=0;wave.forEach(value=>rms+=((value-128)/128)**2);rms=Math.sqrt(rms/wave.length);
      const db=20*Math.log10(Math.max(rms,1e-5));
      $('viz-status').textContent=playing?`LIVE · ${sourceMode==='bluetooth'?'BLUETOOTH · ':''}POST-DSP`:sourceMode==='bluetooth'?'Waiting for Bluetooth playback':tracks.length?'Playback paused':'Choose local or Bluetooth audio';
      $('viz-status').classList.toggle('is-live',playing);
      $('viz-level').textContent=playing?`${db<-90?'−∞':db.toFixed(1)} dBFS RMS`:'POST-DSP AUDIO';
      const energy=f=>{if(!graph||!playing)return 0;const bin=Math.min(spectrum.length-1,Math.max(0,Math.round(f/(graph.ctx.sampleRate/2)*spectrum.length)));return spectrum[bin]/255;};
      if(vizMode==='radial'){
        const cx=w/2,cy=h/2,r=Math.min(h*.25,w*.2),reach=Math.min(h*.22,85);
        const glow=ctx.createRadialGradient(cx,cy,0,cx,cy,r+reach+40);glow.addColorStop(0,'#398bff18');glow.addColorStop(1,'#398bff00');ctx.fillStyle=glow;ctx.fillRect(0,0,w,h);
        [r-12,r+reach+22].forEach(radius=>{ctx.beginPath();ctx.arc(cx,cy,radius,0,Math.PI*2);ctx.strokeStyle='#2b416044';ctx.lineWidth=1;ctx.stroke();});
        const count=96;ctx.lineCap='round';ctx.lineWidth=Math.max(2,Math.min(4,r*.04));
        for(let i=0;i<count;i++){const angle=i/count*Math.PI*2-Math.PI/2,f=35*(16000/35)**(i<count/2?i/(count/2):((count-i)/(count/2))),length=4+energy(f)*reach;ctx.beginPath();ctx.moveTo(cx+Math.cos(angle)*r,cy+Math.sin(angle)*r);ctx.lineTo(cx+Math.cos(angle)*(r+length),cy+Math.sin(angle)*(r+length));ctx.strokeStyle=`hsl(${213+20*Math.sin(angle)} 90% ${58+energy(f)*15}%)`;ctx.stroke();}
        ctx.textAlign='center';ctx.fillStyle='#e8edf5';ctx.font='600 22px system-ui';ctx.fillText('AUDIO',cx,cy+2);ctx.font='9px system-ui';ctx.fillStyle='#8793a5';ctx.fillText('P O S T - D S P',cx,cy+22);ctx.lineCap='butt';
      }else{
        ctx.strokeStyle='#26344988';ctx.lineWidth=1;
        for(let y=h/4;y<h;y+=h/4){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
        if(vizMode==='wave'){
          const displayScale=playing?Math.min(24,Math.max(1,.18/Math.max(rms,.001))):1;
          ctx.beginPath();ctx.strokeStyle='#78b0ff';ctx.lineWidth=2;
          wave.forEach((value,i)=>{const x=i/(wave.length-1)*w,y=h/2+(playing?Math.max(-1,Math.min(1,(value-128)/128*displayScale)):0)*h*.45;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();
          ctx.fillStyle='#7186a3';ctx.font='11px system-ui';ctx.textAlign='left';ctx.fillText(`AMPLITUDE · DISPLAY ×${displayScale.toFixed(1)}`,0,15);ctx.textAlign='right';ctx.fillText(graph?`${Math.round(wave.length/graph.ctx.sampleRate*1000)} ms`:'TIME',w,h-5);
        }else{
          const count=80,base=h-27;const gradient=ctx.createLinearGradient(0,base,0,0);gradient.addColorStop(0,'#24477a');gradient.addColorStop(.5,'#398bff');gradient.addColorStop(1,'#9bd0ff');ctx.fillStyle=gradient;
          for(let i=0;i<count;i++){const f=25*(18000/25)**(i/(count-1)),height=Math.max(2,energy(f)*(base-10));ctx.fillRect(i*w/count,base-height,w/count*.64,height);}
          ctx.font='11px system-ui';ctx.fillStyle='#7186a3';[30,60,125,250,500,1000,2000,4000,8000,16000].forEach(f=>{const x=Math.log(f/25)/Math.log(18000/25)*w;ctx.textAlign='center';ctx.fillText(f>=1000?`${f/1000}k`:`${f}`,Math.max(12,Math.min(w-17,x)),h-6);});
        }
      }
    }draw();
  }
  $('fullscreen-btn').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{toast('Full screen is unavailable in this preview. Use Chromium kiosk mode on the Pi.');}};
  const help={bluetooth:['Bluetooth receiver','Pair your iPhone with CivicPi in Bluetooth settings, then select Use Bluetooth here. Incoming audio enters the same EQ, source-band trims, stereo matrix, compressor and post-DSP visualizer as local music. Keep this dashboard open; control playback on the iPhone.'],spotify:['Spotify Connect','Install and validate a compatible Spotify Connect receiver for Raspberry Pi OS. The Pi needs internet access and device discovery must work on the chosen network. Control playback from the Spotify app on the iPhone. Receiver account requirements vary. Route its output through the same system DSP and HDMI path.'],usb:['Wired iPhone audio','A normal USB-C charging/data cable is not a verified generic audio input into a Pi. One possible wired path is an iPhone-compatible USB-C audio DAC feeding a Pi-compatible USB audio capture interface. That adds hardware and an analog conversion; exact compatibility and charging need verification before purchase. Bluetooth is available through the Pi audio bridge.']};
  all('[data-help]').forEach(b=>b.onclick=()=>{const [title,body]=help[b.dataset.help];$('help-title').textContent=title;$('help-body').textContent=body;$('help-dialog').showModal();});$('close-help').onclick=()=>$('help-dialog').close();
  window.addEventListener('beforeunload',()=>tracks.forEach(t=>{if(t.origin==='local')URL.revokeObjectURL(t.url);if(t.artwork)URL.revokeObjectURL(t.artwork);}));
  window.CivicAudio={getGraph:()=>graph,ensure:ensureAudio};
  showTab('speakers');renderSpeaker();refreshEQ();renderStage();renderVolume();renderLibrary();renderSaveButton();all('input.range').forEach(fill);
  if(location.hash)showPage(location.hash.slice(1));
})();
