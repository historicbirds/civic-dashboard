const assert=require('node:assert/strict');
const {CivicPCMBuffer}=require('../static/js/pcm-player.js');
const buffer=new CivicPCMBuffer();
const left=new Float32Array(128),right=new Float32Array(128);
buffer.render(left,right);assert.ok(left.every(v=>v===0));
const stereo=new Float32Array(960*2);
for(let i=0;i<960;i++){stereo[i*2]=.25;stereo[i*2+1]=-.75;}
for(let i=0;i<4;i++)buffer.push(stereo);
buffer.render(left,right);
assert.ok(left.every(v=>v===.25));assert.ok(right.every(v=>v===-.75));
// A stalled browser must discard old samples instead of accumulating latency.
for(let i=0;i<1000;i++)buffer.push(stereo);
assert.ok(buffer.write-buffer.read<=buffer.target*3);
assert.ok(buffer.dropped>0);
buffer.clear();buffer.render(left,right);assert.ok(left.every(v=>v===0));
const malformed=new Float32Array(960*2).fill(NaN);
for(let i=0;i<4;i++)buffer.push(malformed);
buffer.render(left,right);assert.ok(left.every(Number.isFinite));
// Five minutes with a modest input/output clock difference stays bounded.
buffer.clear();let frames=0;
for(let i=0;i<112500;i++){
  frames+=128*1.001;
  while(frames>=960){buffer.push(stereo);frames-=960;}
  buffer.render(left,right);
  assert.ok(buffer.write-buffer.read<buffer.target*3);
}
assert.ok(buffer.frames>14000000);
console.log('PASS: stereo PCM, silence, bounded latency, finite samples and clock drift');
