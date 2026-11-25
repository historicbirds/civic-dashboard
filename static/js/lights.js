(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  let visible=false,status=null,pollTimer=null,polling=false,actionBusy=false,pulseBusy=false,tap=null,tapGraph=null,lastSample=performance.now();
  const envelope=new CivicBass.Envelope();
  let sensitivity=.6,strength=.9;
  try{const saved=JSON.parse(localStorage.getItem('civic-light-response')||'null');if(saved?.version===2){sensitivity=Math.max(.1,Math.min(2,Number.isFinite(saved.sensitivity)?saved.sensitivity:.6));strength=Math.max(0,Math.min(1,Number.isFinite(saved.strength)?saved.strength:.9));}}catch{}
  $('light-sensitivity').value=sensitivity;$('light-strength').value=Math.round(strength*100);
  function fill(input){input.style.setProperty('--fill',`${100*(Number(input.value)-Number(input.min))/(Number(input.max)-Number(input.min))}%`);}
  function render(data){
    status=data;const ready=data.connected===true,bass=data.mode==='bass';
    $('light-badge').textContent=ready?'Connected':({setup:'Setup needed',disabled:'Setup pending',connecting:'Connecting',reading:'Reading controller',reconnecting:'Reconnecting',stale:'Waiting for state'}[data.state]||'Not connected');
    $('light-badge').classList.toggle('obd-live',ready);$('light-controls').disabled=!ready||actionBusy;
    $('light-message').textContent=data.error||data.message||'Waiting for the light controller.';
    $('light-detail').textContent=ready?(bass?(data.pulsing?'Bass pulse active':'Bass pulse armed · waiting for audio'):`Controller updated ${Math.floor(data.age_seconds||0)}s ago`):'Power the ATOTO light controller to connect.';
    document.querySelectorAll('[data-light-mode]').forEach(b=>{const active=b.dataset.lightMode===data.mode;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
    $('light-response').hidden=!bass;
    for(const zone of ['front','rear']){
      const value=bass?data.limits?.[zone]:data.reported?.[zone];
      if(value!=null&&document.activeElement!==$(`light-${zone}`))$(`light-${zone}`).value=value;
      fill($(`light-${zone}`));
      $(`light-${zone}-value`).textContent=value==null?'—':`${value} / 9`;
      $(`light-${zone}-label`).textContent=`${zone==='front'?'Front':'Rear'} ${bass?'maximum':'brightness'}`;
    }
    const color=data.reported?.color;
    if(color){$('light-preview').style.background=color;$('light-color-value').textContent=color;if(document.activeElement!==$('light-color'))$('light-color').value=color;}
    else{$('light-color-value').textContent='—';$('light-preview').style.background='#263449';}
    for(const on of [true,false]){const b=$(on?'light-on':'light-off'),active=ready&&data.reported?.power===(on?1:0);b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));}
  }
  async function poll(){
    if(polling)return;
    polling=true;
    try{const response=await fetch('/api/lights/status',{cache:'no-store',signal:AbortSignal.timeout(3000)});if(!response.ok)throw new Error();render(await response.json());}
    catch{render({connected:false,state:'reconnecting',mode:status?.mode||'solid',message:location.protocol==='file:'?'Run the Flask dashboard on the Pi for lighting control.':'Lighting service unavailable. Retrying…'});}
    finally{polling=false;schedule();}
  }
  function schedule(){clearTimeout(pollTimer);if(visible||status?.mode==='bass')pollTimer=setTimeout(poll,1000);}
  async function action(value){
    if(actionBusy)return;
    actionBusy=true;$('light-controls').disabled=true;
    try{
      if(value.mode==='bass')await window.CivicAudio.ensure();
      const response=await fetch('/api/lights/settings',{method:'POST',headers:{'Content-Type':'application/json','X-Civic-Request':'1'},body:JSON.stringify(value),signal:AbortSignal.timeout(4000)});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'Lighting command failed.');
      // Reported controls update only from controller notifications, not this POST.
      await new Promise(resolve=>setTimeout(resolve,600));await poll();
    }catch(error){$('light-message').textContent=error.message;}
    finally{actionBusy=false;$('light-controls').disabled=status?.connected!==true;}
  }
  $('light-on').onclick=()=>action({power:true});$('light-off').onclick=()=>action({power:false});
  $('light-reconnect').onclick=async()=>{try{await fetch('/api/lights/reconnect',{method:'POST',headers:{'X-Civic-Request':'1'}});poll();}catch{$('light-message').textContent='Lighting service unavailable.';}};
  document.querySelectorAll('[data-light-mode]').forEach(b=>b.onclick=()=>action({mode:b.dataset.lightMode}));
  document.querySelectorAll('[data-light-color]').forEach(b=>b.onclick=()=>action({color:b.dataset.lightColor}));
  $('light-color').onchange=()=>action({color:$('light-color').value});
  for(const zone of ['front','rear']){$(`light-${zone}`).oninput=()=>{fill($(`light-${zone}`));$(`light-${zone}-value`).textContent=`${$(`light-${zone}`).value} / 9`;};$(`light-${zone}`).onchange=()=>action({[zone]:Number($(`light-${zone}`).value)});}
  function responseSettings(){
    sensitivity=Number($('light-sensitivity').value);strength=Number($('light-strength').value)/100;
    fill($('light-sensitivity'));fill($('light-strength'));
    $('light-sensitivity-value').textContent=sensitivity.toFixed(1)+'×';$('light-strength-value').textContent=Math.round(strength*100)+'%';
    try{localStorage.setItem('civic-light-response',JSON.stringify({version:2,sensitivity,strength}));}catch{}
  }
  $('light-sensitivity').oninput=responseSettings;$('light-strength').oninput=responseSettings;responseSettings();
  setInterval(async()=>{
    const now=performance.now(),dt=(now-lastSample)/1000;lastSample=now;
    if(status?.mode!=='bass'||!status.connected||document.hidden){envelope.reset();return;}
    const graph=window.CivicAudio?.getGraph();if(!graph||graph.ctx.state!=='running')return;
    if(graph!==tapGraph){tap?.close();tap=CivicBass.createTap(graph);tapGraph=graph;}
    const intensity=envelope.update(tap.sample(),dt,sensitivity,strength);
    $('light-bass-fill').style.width=`${Math.round(intensity*100)}%`;
    if(pulseBusy)return;
    pulseBusy=true;
    try{await fetch('/api/lights/pulse',{method:'POST',headers:{'Content-Type':'application/json','X-Civic-Request':'1'},body:JSON.stringify({level:intensity}),signal:AbortSignal.timeout(800)});}catch{}finally{pulseBusy=false;}
  },125);
  window.CivicLights={setVisible(value){visible=value;if(visible)poll();else schedule();}};
})();
