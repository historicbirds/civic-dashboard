/* 12 dB/oct Linkwitz–Riley source-band splitter. No hardware-specific commands. */
(function (root) {
  'use strict';
  const frequencies=[20,25,31.5,40,50,63,80,100,125,160,200,250,315,400,500,630,800,1000,1250,1600,2000,2500,3150,4000,5000,6300,8000,10000,12500,16000,20000];
  const grids=new Map();
  function peaking(frequency,sampleRate,gain,Q=4.318){
    const w=2*Math.PI*Math.min(frequency,sampleRate*.499)/sampleRate;
    const A=10**(gain/40),alpha=Math.sin(w)/(2*Q),c=Math.cos(w),a0=1+alpha/A;
    return {feedforward:[(1+alpha*A)/a0,-2*c/a0,(1-alpha*A)/a0],
      feedback:[1,-2*c/a0,(1-alpha/A)/a0]};
  }
  function eqHeadroom(gains,sampleRate,bypass=false){
    if(bypass||!gains.some(g=>g>0))return {peakDB:0,attenuationDB:0,gain:1};
    if(!grids.has(sampleRate)){
      const points=[0,sampleRate/2,...frequencies.map(f=>Math.min(f,sampleRate*.499))];
      for(let i=0;i<4096;i++)points.push(5*(sampleRate*.49999/5)**(i/4095));
      const grid=points.map(f=>{const w=2*Math.PI*f/sampleRate;return [Math.cos(w),Math.sin(w),Math.cos(2*w),Math.sin(2*w)];});
      if(grids.size>=4)grids.clear();grids.set(sampleRate,grid);
    }
    const response=new Float64Array(grids.get(sampleRate).length),grid=grids.get(sampleRate);
    gains.forEach((gain,i)=>{
      if(!gain)return;
      const {feedforward:b,feedback:a}=peaking(frequencies[i],sampleRate,gain);
      grid.forEach(([c,s,c2,s2],j)=>{
        const nr=b[0]+b[1]*c+b[2]*c2,ni=b[1]*s+b[2]*s2;
        const dr=a[0]+a[1]*c+a[2]*c2,di=a[1]*s+a[2]*s2;
        response[j]+=10*Math.log10(Math.max(1e-30,(nr*nr+ni*ni)/Math.max(1e-30,dr*dr+di*di)));
      });
    });
    let peakDB=0;for(const value of response)peakDB=Math.max(peakDB,value);
    // Guard the sampled response estimate; flat/cut-only/bypassed EQ stays at unity.
    const attenuationDB=peakDB>1e-5?Math.ceil((peakDB+.25)*10)/10:0;
    return {peakDB,attenuationDB,gain:10**(-attenuationDB/20)};
  }
  function crossover(frequency, sampleRate, type) {
    const k = Math.tan(Math.PI * frequency / sampleRate);
    const norm = 1 / (1 + 2*k + k*k); // Q = 0.5, two coincident real poles.
    const feedforward = type === 'lowpass' ? [k*k*norm,2*k*k*norm,k*k*norm] : [norm,-2*norm,norm];
    return {feedforward, feedback:[1,2*(k*k-1)*norm,(1-2*k+k*k)*norm]};
  }
  function allpass(frequency, sampleRate) {
    const k = Math.tan(Math.PI * frequency / sampleRate), a = (k-1)/(k+1);
    return {feedforward:[a,1],feedback:[1,a]};
  }
  function createBands(ctx, input, output) {
    const make = coefficients => ctx.createIIRFilter(coefficients.feedforward,coefficients.feedback);
    const low = make(crossover(70,ctx.sampleRate,'lowpass'));
    const upperPhase = make(allpass(3500,ctx.sampleRate));
    const upper = make(crossover(70,ctx.sampleRate,'highpass'));
    const mid = make(crossover(3500,ctx.sampleRate,'lowpass'));
    const high = make(crossover(3500,ctx.sampleRate,'highpass'));
    const gains = {low:ctx.createGain(),mid:ctx.createGain(),high:ctx.createGain()};
    // The upper split's first-order allpass also compensates the low branch.
    // Middle-band polarity inversion makes the unity sum a flat allpass response.
    input.connect(low);low.connect(upperPhase);upperPhase.connect(gains.low);gains.low.connect(output);
    input.connect(upper);upper.connect(mid);upper.connect(high);mid.connect(gains.mid);high.connect(gains.high);
    gains.mid.gain.value=-1;gains.mid.connect(output);gains.high.connect(output);
    return gains;
  }
  const api = {crossover,allpass,createBands,frequencies,peaking,eqHeadroom};
  if(typeof module !== 'undefined' && module.exports) module.exports=api; else root.CivicDSP=api;
})(typeof window === 'undefined' ? {} : window);
