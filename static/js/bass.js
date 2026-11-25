(function(root){
  'use strict';
  class Envelope {
    constructor(){this.reset();}
    reset(){this.value=0;this.baseline=0;this.previous=0;this.initialized=false;}
    update(rms,dt,sensitivity=.6,strength=.9){
      rms=Math.max(0,Math.min(1,Number.isFinite(rms)?rms:0));
      dt=Math.max(0,Math.min(.5,Number.isFinite(dt)?dt:0));
      sensitivity=Math.max(.1,Math.min(2,Number.isFinite(sensitivity)?sensitivity:.6));
      strength=Math.max(0,Math.min(1,Number.isFinite(strength)?strength:.9));
      if(!this.initialized){this.baseline=rms;this.previous=rms;this.initialized=true;return 0;}
      // Detect upward changes relative to recent bass energy. A sustained note
      // produces one onset, then releases instead of holding maximum brightness.
      const rise=Math.max(0,(rms-this.previous)/Math.max(.006,this.baseline)-.12);
      const target=rms>.003?Math.min(1,rise*1.8*sensitivity):0;
      this.baseline+=(rms-this.baseline)*(1-Math.exp(-dt/.8));
      this.previous=rms;
      const time=target>this.value ? .025 : .18;
      this.value+=(target-this.value)*(1-Math.exp(-dt/time));
      return strength*this.value;
    }
  }
  function createTap(graph){
    const {ctx,volume}=graph,split=ctx.createChannelSplitter(2),silent=ctx.createGain();silent.gain.value=0;
    volume.connect(split);silent.connect(ctx.destination);
    const analysers=[0,1].map(channel=>{
      const high=ctx.createBiquadFilter(),low=ctx.createBiquadFilter(),analyser=ctx.createAnalyser();
      high.type='highpass';high.frequency.value=25;high.Q.value=20*Math.log10(Math.SQRT1_2);
      low.type='lowpass';low.frequency.value=90;low.Q.value=20*Math.log10(Math.SQRT1_2);
      analyser.fftSize=2048;split.connect(high,channel);high.connect(low);low.connect(analyser);analyser.connect(silent);
      return {high,low,analyser,data:new Float32Array(analyser.fftSize)};
    });
    return {sample(){
      if(ctx.state!=='running')return 0;
      let energy=0,count=0;
      for(const {analyser,data} of analysers){analyser.getFloatTimeDomainData(data);for(const value of data){energy+=value*value;count++;}}
      return Math.sqrt(energy/count);
    },close(){volume.disconnect(split);split.disconnect();silent.disconnect();for(const a of analysers){a.high.disconnect();a.low.disconnect();a.analyser.disconnect();}}};
  }
  const api={Envelope,createTap};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.CivicBass=api;
})(typeof window!=='undefined'?window:globalThis);
