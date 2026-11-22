/* Read common ID3v2.3/v2.4 and FLAC metadata locally; never upload music. */
window.CivicMetadata = async function(file) {
  const bytes=new Uint8Array(await file.slice(0,4*1024*1024).arrayBuffer());
  const view=new DataView(bytes.buffer), result={};
  const latin=(start,end)=>new TextDecoder('iso-8859-1').decode(bytes.subarray(start,end));
  const u32=offset=>view.getUint32(offset,false);
  const sync=offset=>(bytes[offset]<<21)|(bytes[offset+1]<<14)|(bytes[offset+2]<<7)|bytes[offset+3];
  const text=data=>{if(!data.length)return '';const enc=data[0],content=data.subarray(1);return new TextDecoder(enc===0?'iso-8859-1':enc===3?'utf-8':enc===2?'utf-16be':content[0]===254?'utf-16be':'utf-16le').decode(content).replace(/\u0000/g,'').replace(/^\uFEFF/,'').trim();};
  function artwork(data,mime){if(data.length>0&&data.length<=3*1024*1024&&['image/jpeg','image/png','image/webp'].includes(mime.toLowerCase()))result.artwork=URL.createObjectURL(new Blob([data],{type:mime}));}
  function flacPicture(start,end){let pos=start;if(pos+8>end)return;pos+=4;const mimeSize=u32(pos);pos+=4;if(pos+mimeSize+4>end)return;const mime=latin(pos,pos+mimeSize);pos+=mimeSize;const descriptionSize=u32(pos);pos+=4+descriptionSize+16;if(pos+4>end)return;const length=u32(pos);pos+=4;if(pos+length<=end)artwork(bytes.subarray(pos,pos+length),mime);}
  if(latin(0,4)==='fLaC'){
    let pos=4,last=false;
    while(!last&&pos+4<=bytes.length){last=!!(bytes[pos]&128);const type=bytes[pos]&127,length=(bytes[pos+1]<<16)|(bytes[pos+2]<<8)|bytes[pos+3],start=pos+4,end=start+length;if(end>bytes.length)break;
      if(type===4){let p=start;const le=offset=>view.getUint32(offset,true);if(p+4>end)break;const vendor=le(p);p+=4+vendor;if(p+4>end)break;const count=Math.min(le(p),10000);p+=4;for(let i=0;i<count&&p+4<=end;i++){const size=le(p);p+=4;if(p+size>end)break;const comment=new TextDecoder().decode(bytes.subarray(p,p+size)),split=comment.indexOf('=');if(split>0){const key=comment.slice(0,split).toUpperCase();if(['TITLE','ARTIST','ALBUM'].includes(key))result[key.toLowerCase()]=comment.slice(split+1);}p+=size;}}
      if(type===6&&!result.artwork)flacPicture(start,end);pos=end;
    }
  }else if(latin(0,3)==='ID3'&&bytes.length>=10){
    const version=bytes[3];if(![3,4].includes(version)||(bytes[5]&128))return result;
    const end=Math.min(bytes.length,10+sync(6));let pos=10;
    if(bytes[5]&64){if(pos+4>end)return result;pos+=version===4?sync(pos):4+u32(pos);}
    while(pos+10<=end){const id=latin(pos,pos+4),size=version===4?sync(pos+4):u32(pos+4),flags=bytes[pos+9],start=pos+10,finish=start+size;if(!/^[A-Z0-9]{4}$/.test(id)||size===0||finish>end)break;
      // Skip compressed, encrypted or per-frame-unsynchronized payloads.
      if(!(flags&(version===4?0x4f:0xe0))){if(['TIT2','TPE1','TALB'].includes(id))result[{TIT2:'title',TPE1:'artist',TALB:'album'}[id]]=text(bytes.subarray(start,finish));
        if(id==='APIC'&&!result.artwork){let p=start+1;while(p<finish&&bytes[p])p++;const mime=latin(start+1,p);p+=2;const encoding=bytes[start];if(encoding===0||encoding===3){while(p<finish&&bytes[p])p++;p++;}else{while(p+1<finish&&(bytes[p]||bytes[p+1]))p+=2;p+=2;}if(p<finish)artwork(bytes.subarray(p,finish),mime);}}
      pos=finish;
    }
  }
  return result;
};
