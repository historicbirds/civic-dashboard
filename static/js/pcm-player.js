/* Bounded stereo jitter buffer. Input is 48 kHz interleaved Float32 PCM. */
class CivicPCMBuffer {
  constructor(rate=48000) {
    this.capacity=rate/2; this.target=Math.round(rate*.08);
    this.data=new Float32Array(this.capacity*2); this.read=0; this.write=0;
    this.primed=false; this.frames=0; this.underruns=0; this.dropped=0;
  }
  clear(){this.read=this.write=0;this.primed=false;this.data.fill(0);}
  push(samples){
    if(!(samples instanceof Float32Array)||samples.length%2)return;
    const frames=samples.length/2;if(frames>this.capacity)return;
    // A stalled main thread must never produce seconds of stale audio.
    if(this.write-this.read+frames>this.target*3){
      const keep=Math.max(0,this.target-frames);
      const next=Math.max(this.read,this.write-keep);
      this.dropped+=Math.floor(next-this.read);this.read=next;this.primed=false;
    }
    for(let i=0;i<frames;i++)for(let ch=0;ch<2;ch++){
      const value=samples[i*2+ch];
      this.data[((this.write+i)%this.capacity)*2+ch]=Number.isFinite(value)?value:0;
    }
    this.write+=frames;
  }
  render(left,right){
    left.fill(0);right.fill(0);
    let available=this.write-this.read;
    if(!this.primed){if(available<this.target)return;this.primed=true;}
    // The Bluetooth capture clock and Chromium output clock can drift slightly.
    const step=1+Math.max(-.003,Math.min(.003,(available-this.target)/this.target*.0005));
    for(let i=0;i<left.length;i++){
      if(this.write-this.read<2){this.primed=false;this.underruns++;break;}
      const index=Math.floor(this.read),part=this.read-index;
      for(let ch=0;ch<2;ch++){
        const a=this.data[(index%this.capacity)*2+ch];
        const b=this.data[((index+1)%this.capacity)*2+ch];
        (ch?right:left)[i]=a+(b-a)*part;
      }
      this.read+=step;this.frames++;
    }
  }
}
if(typeof AudioWorkletProcessor!=='undefined'){
  class CivicPCMPlayer extends AudioWorkletProcessor {
    constructor(){super();this.buffer=new CivicPCMBuffer(sampleRate);this.ticks=0;
      this.port.onmessage=event=>{if(event.data==='clear')this.buffer.clear();else this.buffer.push(event.data);};}
    process(inputs,outputs){
      const out=outputs[0];if(out?.length===2)this.buffer.render(out[0],out[1]);
      if(++this.ticks%200===0)this.port.postMessage({frames:this.buffer.frames,underruns:this.buffer.underruns,dropped:this.buffer.dropped});
      return true;
    }
  }
  registerProcessor('civic-pcm-player',CivicPCMPlayer);
}
if(typeof module!=='undefined')module.exports={CivicPCMBuffer};
