/* 12 dB/oct Linkwitz–Riley source-band splitter. No hardware-specific commands. */
(function (root) {
  'use strict';
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
  const api = {crossover,allpass,createBands};
  if(typeof module !== 'undefined' && module.exports) module.exports=api; else root.CivicDSP=api;
})(typeof window === 'undefined' ? {} : window);
