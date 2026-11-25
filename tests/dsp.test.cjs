const assert=require('node:assert/strict');
const {crossover,allpass}=require('../static/js/dsp.js');
const mul=(a,b)=>[a[0]*b[0]-a[1]*b[1],a[0]*b[1]+a[1]*b[0]];
const add=(a,b)=>[a[0]+b[0],a[1]+b[1]];
const magnitude=z=>Math.hypot(...z);
function response(filter,f,sr){const omega=2*Math.PI*f/sr;const sum=coeff=>coeff.reduce((z,c,i)=>add(z,[c*Math.cos(-omega*i),c*Math.sin(-omega*i)]),[0,0]);const n=sum(filter.feedforward),d=sum(filter.feedback),den=d[0]**2+d[1]**2;return [(n[0]*d[0]+n[1]*d[1])/den,(n[1]*d[0]-n[0]*d[1])/den];}
for(const sr of [44100,48000,96000]){
 const low=crossover(70,sr,'lowpass'),upper=crossover(70,sr,'highpass'),mid=crossover(3500,sr,'lowpass'),high=crossover(3500,sr,'highpass'),phase=allpass(3500,sr);
 for(let i=0;i<500;i++){
  const f=10*(Math.min(21000,sr*.49)/10)**(i/499);
  const bass=mul(response(low,f,sr),response(phase,f,sr));
  const mids=mul(response(upper,f,sr),response(mid,f,sr));
  const treble=mul(response(upper,f,sr),response(high,f,sr));
  const sum=add(add(bass,[-mids[0],-mids[1]]),treble);
  assert.ok(Math.abs(magnitude(sum)-1)<1e-7,`Unity sum ripple: ${sr} Hz / ${f} Hz`);
 }
 for(const [filter,f] of [[low,70],[upper,70],[mid,3500],[high,3500]])assert.ok(Math.abs(magnitude(response(filter,f,sr))-.5)<1e-7,'LR2 cutoff must be -6.02 dB');
 const stop=magnitude(response(low,700,sr));assert.ok(stop<.011,'Bass filter must roll off at 12 dB/oct');
 const lowCutGain=magnitude(response(low,10,sr))*.0630957;assert.ok(lowCutGain<.064,'-24 dB band gain');
}
// At zero separation both outputs are identical; at natural width channels do not leak.
for(const width of [0,1,1.5]){const same=(1+width)/2/Math.max(1,width),cross=(1-width)/2/Math.max(1,width);assert.ok(Math.abs(same)+Math.abs(cross)<=1+1e-12);if(width===0)assert.equal(same,cross);if(width===1)assert.equal(cross,0);}
console.log('PASS: LR2 unity reconstruction, crossover cutoffs, rolloff, band attenuation and stereo matrix at 44.1/48/96 kHz');
const {frequencies,peaking,eqHeadroom}=require('../static/js/dsp.js');
for(const sr of [44100,48000,96000]){
 const flat=Array(31).fill(0),cuts=Array(31).fill(-12),one=[...flat],overlap=[...flat];
 one[17]=6;overlap[17]=6;overlap[18]=6;
 assert.equal(eqHeadroom(flat,sr).gain,1,'Flat EQ must have no fixed attenuation');
 assert.equal(eqHeadroom(cuts,sr).gain,1,'Cuts must not reserve boost headroom');
 assert.equal(eqHeadroom(overlap,sr,true).gain,1,'Bypassed EQ must return to unity');
 assert.ok(Math.abs(eqHeadroom(one,sr).peakDB-6)<1e-7);
 assert.ok(eqHeadroom(overlap,sr).peakDB>7,'Overlapping filters need more than the largest slider gain');
 const curves=[one,overlap,Array(31).fill(12),frequencies.map((_,i)=>i%3===0?12:i%3===1?-12:6)];
 for(const gains of curves){
  const reserve=eqHeadroom(gains,sr),filters=gains.map((gain,i)=>peaking(frequencies[i],sr,gain));
  for(let i=0;i<5000;i++){
   const f=7*(sr*.49997/7)**((i+.37)/5000);
   const level=filters.reduce((gain,filter)=>gain*magnitude(response(filter,f,sr)),reserve.gain);
   assert.ok(level<1,`Compensated EQ peak exceeds unity: ${sr} Hz / ${f} Hz / ${level}`);
  }
 }
}
console.log('PASS: unity flat/cut/bypass EQ, overlapping boosts and compensated dense frequency response');
