const assert=require('node:assert/strict');const {Envelope}=require('../static/js/bass.js');
let e=new Envelope();assert.equal(e.update(0,.125,1,1),0);
let attack=e.update(.1,.125,1,1);assert(attack>.9&&attack<=1);
let release=e.update(0,.125,1,1);assert(release>0&&release<attack);
for(let i=0;i<20;i++)release=e.update(0,.125,1,1);assert(release<.0001);
// Sustained bass, even at near full scale, must not hold the lights on.
for(const rms of [.01,.1,.3,.9]){const steady=new Envelope();steady.update(0,.125);let out;for(let i=0;i<50;i++)out=steady.update(rms,.125,2,1);assert(out<.0001);}
// Repeated kick-like hits produce separate peaks and dark gaps at each loudness.
for(const gain of [.2,1,3]){let hit=new Envelope();for(let i=0;i<5;i++)hit.update(.025*gain,.125,.6,1);let peaks=[],gaps=[];for(let beat=0;beat<8;beat++){peaks.push(hit.update(.14*gain,.125,.6,1));let gap;for(let i=0;i<6;i++)gap=hit.update(.025*gain,.125,.6,1);gaps.push(gap);}assert(Math.min(...peaks)>.8);assert(Math.max(...gaps)<.03);}
for(const rms of [0,.0001,.01,.1,1,Infinity,NaN])for(const sensitivity of [.1,.6,2])for(const strength of [0,.5,1]){let env=new Envelope();env.update(0,.125);let value=env.update(rms,.125,sensitivity,strength);assert(value>=0&&value<=1);if(strength===0)assert.equal(value,0);}
const quiet=new Envelope(),loud=new Envelope();quiet.update(.05,.125);loud.update(.05,.125);assert(loud.update(.07,.125,2,1)>quiet.update(.07,.125,.1,1));
e.reset();assert.equal(e.update(.5,.125),0);
console.log('PASS: separate bass-hit peaks, sustained-bass rejection across loudness levels, dark gaps, zero-strength silence, bounded sensitivity, attack/release and reset');
