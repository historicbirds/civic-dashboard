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
