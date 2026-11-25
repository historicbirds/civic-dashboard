(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  let visible=false,timer=null,controller=null,generation=0;
  const labels={disabled:'Setup pending',setup:'Setup needed',connecting:'Connecting',initializing:'Reading ECU',live:'Connected',stale:'Readings stale',adapter_only:'No ECU response',reconnecting:'Reconnecting'};
  function clearReadings(){document.querySelectorAll('[data-obd-value]').forEach(el=>el.textContent='—');}
  function render(data){
    $('obd-badge').textContent=labels[data.state]||'Not connected';
    $('obd-badge').classList.toggle('obd-live',data.live===true);
    $('obd-message').textContent=data.message||'Waiting for vehicle data.';
    $('obd-protocol').textContent=data.live&&data.protocol?data.protocol:'ELM327 · read-only';
    $('obd-age').textContent=data.age_seconds==null?'No vehicle readings yet':data.live?`Updated ${Math.floor(data.age_seconds)}s ago`:`Last ECU response ${Math.floor(data.age_seconds)}s ago`;
    $('obd-voltage-label').textContent=data.voltage_source==='adapter'?'OBD2 supply voltage':'ECU voltage';
    document.querySelectorAll('[data-obd-value]').forEach(el=>{
      const key=el.dataset.obdValue,sample=data.sensors?.[key],fresh=data.live&&sample?.value!=null&&Number.isFinite(sample.value);
      const decimals=key==='voltage'?1:['load','throttle','short_trim','long_trim','map'].includes(key)?1:0;
      el.textContent=fresh?sample.value.toFixed(decimals):'—';
      el.closest('article').classList.toggle('unavailable',!fresh);
      const detail=el.closest('article').querySelector('[data-obd-detail]');
      if(detail)detail.textContent=sample?.supported===false?'Not supported by this ECU':fresh?`Updated ${Math.floor(sample.age_seconds||0)}s ago`:sample?.supported===true?'Waiting for a fresh reading':data.live?'No reading returned':'Awaiting connection';
    });
    const list=$('obd-code-list');list.replaceChildren();
    if(Array.isArray(data.codes)){
      $('obd-codes-state').textContent=data.codes_error|| (data.codes.length?`${data.codes.length} stored ${data.codes.length===1?'code':'codes'}`:'No stored trouble codes reported');
      for(const item of data.codes){const row=document.createElement('article');row.className='obd-code';const code=document.createElement('strong'),description=document.createElement('p');code.textContent=item.code;description.textContent=item.description||'Description unavailable';row.append(code,description);list.append(row);}
    }else $('obd-codes-state').textContent=data.codes_error|| (data.live?'Select Scan codes to read stored codes.':'Connect to the vehicle to read trouble codes.');
    $('obd-scan-codes').disabled=!data.live||data.codes_scanning;
    $('obd-scan-codes').textContent=data.codes_scanning?'Reading…':'Scan codes';
    $('obd-code-age').textContent=data.codes_age_seconds==null?'':`Code scan ${Math.floor(data.codes_age_seconds)}s ago · generic OBD2 descriptions`;
  }
  async function poll(){
    if(!visible||document.hidden)return schedule();
    if(controller)return;
    const requestController=new AbortController(),version=generation;
    controller=requestController;const timeout=setTimeout(()=>requestController.abort(),3000);
    try{
      const response=await fetch('/api/obd/status',{cache:'no-store',signal:requestController.signal});
      if(!response.ok)throw new Error();
      const data=await response.json();if(visible&&version===generation)render(data);
    }catch(error){
      if(visible&&version===generation){clearReadings();$('obd-code-list').replaceChildren();$('obd-codes-state').textContent='Diagnostics unavailable · no current code scan';$('obd-badge').textContent='Not connected';$('obd-badge').classList.remove('obd-live');$('obd-message').textContent=location.protocol==='file:'?'Run the Flask dashboard on the Pi for live OBD2 readings.':'Diagnostics service is unavailable. Retrying…';$('obd-scan-codes').disabled=true;}
    }finally{clearTimeout(timeout);if(controller===requestController)controller=null;if(version===generation)schedule();}
  }
  function schedule(){clearTimeout(timer);if(visible)timer=setTimeout(poll,1000);}
  async function action(path){
    try{const response=await fetch(path,{method:'POST',headers:{'X-Civic-Request':'1'}});const data=await response.json();if(!response.ok)throw new Error(data.error||'The request could not be completed.');clearTimeout(timer);poll();}
    catch(error){$('obd-message').textContent=error.message;}
  }
  $('obd-reconnect').onclick=()=>action('/api/obd/reconnect');
  $('obd-scan-codes').onclick=()=>action('/api/obd/codes');
  document.querySelectorAll('[data-obd-view]').forEach(button=>button.onclick=()=>{
    document.querySelectorAll('[data-obd-view]').forEach(b=>{const active=b===button;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
    document.querySelectorAll('[data-obd-panel]').forEach(panel=>panel.hidden=panel.dataset.obdPanel!==button.dataset.obdView);
  });
  window.CivicDiagnostics={setVisible(value){visible=value;generation++;clearTimeout(timer);controller?.abort();controller=null;if(visible)poll();}};
})();
