/* Same-origin, local-only input to the existing Web Audio DSP. No microphone. */
window.CivicBluetooth = class {
  constructor(onChange){
    this.onChange=onChange;this.selected=false;this.active=false;this.info={};
    this.socket=null;this.node=null;this.retry=null;this.lastPacket=0;
    this.poll();this.pollTimer=setInterval(()=>this.poll(),2000);
  }
  notify(error=''){
    this.active=!!this.selected&&this.socket?.readyState===WebSocket.OPEN&&
      this.context?.state==='running'&&performance.now()-this.lastPacket<1500;
    this.onChange({...this.info,selected:this.selected,active:this.active,error:error||this.info.error||''});
  }
  async poll(){
    if(location.protocol==='file:')return;
    try{const response=await fetch('/api/bluetooth/status',{cache:'no-store'});
      if(!response.ok)throw new Error('Bluetooth is available on the Pi display only.');
      this.info=await response.json();this.notify();
    }catch(error){this.info={ready:false,error:error.message};this.notify();}
  }
  async start(context,input){
    this.stop();this.context=context;this.input=input;
    if(context.sampleRate!==48000)throw new Error('Bluetooth requires a 48 kHz audio context. Reload this page.');
    if(this.moduleContext!==context){await context.audioWorklet.addModule('/static/js/pcm-player.js');this.moduleContext=context;}
    if(context.state!=='running')throw new Error('Tap Use Bluetooth to enable audio.');
    this.node=new AudioWorkletNode(context,'civic-pcm-player',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[2]});
    this.node.connect(input);this.selected=true;this.connect();
  }
  connect(){
    if(!this.selected)return;
    this.lastPacket=0;
    const socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/api/bluetooth/audio`);
    socket.binaryType='arraybuffer';this.socket=socket;
    socket.onmessage=event=>{
      if(this.socket!==socket)return;
      if(typeof event.data==='string'){
        const message=JSON.parse(event.data);
        if(message.error){this.notify(message.error);socket.close();return;}
        if(message.sample_rate!==48000||message.channels!==2){this.notify('Unsupported Bluetooth audio format.');socket.close();return;}
        socket.send('ready');socket.send('heartbeat');
        this.heartbeat=setInterval(()=>{
          if(socket.readyState===WebSocket.OPEN&&this.context.state==='running')socket.send('heartbeat');
        },1000);
      }else{
        if(event.data.byteLength%8)return;
        this.lastPacket=performance.now();
        this.node.port.postMessage(new Float32Array(event.data),[event.data]);
        if(!this.active)this.notify();
      }
    };
    socket.onclose=()=>{
      if(this.socket!==socket)return;
      clearInterval(this.heartbeat);this.socket=null;this.node?.port.postMessage('clear');
      this.notify('Bluetooth bridge reconnecting…');
      if(this.selected)this.retry=setTimeout(()=>this.connect(),2000);
    };
    socket.onerror=()=>{};this.notify();
  }
  stop(){
    this.selected=false;this.active=false;clearTimeout(this.retry);clearInterval(this.heartbeat);
    const socket=this.socket;this.socket=null;socket?.close();
    this.node?.disconnect();this.node=null;this.lastPacket=0;this.notify();
  }
  get playing(){return this.selected&&this.active&&this.info.playing===true;}
};
