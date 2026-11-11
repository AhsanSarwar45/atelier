import React, {Component, useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Player, type PlayerRef} from '@remotion/player';
type Config = {title:string;width:number;height:number;fps:number;durationInFrames:number;inputProps?:Record<string,unknown>;chapters?:{frame:number;label:string}[]};
class Boundary extends Component<React.PropsWithChildren, {failed:boolean}> {
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<p role="alert">Couldn't play this explanation.</p>:this.props.children;}
}
function Playback({composition,config}:{composition:React.ComponentType<any>;config:Config}) {
  const player=useRef<PlayerRef>(null);
  const [frame,setFrame]=useState(0);
  const [playing,setPlaying]=useState(false);
  useEffect(()=>{
    const ref=player.current;
    const onFrame=({detail}:{detail:{frame:number}})=>setFrame(detail.frame);
    const onPlay=()=>setPlaying(true),onPause=()=>setPlaying(false);
    ref?.addEventListener('play',onPlay);ref?.addEventListener('pause',onPause);ref?.addEventListener('ended',onPause);
    const onVisibility=()=>{if(document.hidden)ref?.pause();};
    ref?.addEventListener('frameupdate',onFrame);
    document.addEventListener('visibilitychange',onVisibility);
    return ()=>{ref?.removeEventListener('play',onPlay);ref?.removeEventListener('pause',onPause);ref?.removeEventListener('ended',onPause);ref?.removeEventListener('frameupdate',onFrame);document.removeEventListener('visibilitychange',onVisibility);};
  },[]);
  return <main data-frame={frame} style={{height:'100%',display:'flex',flexDirection:'column',padding:8,gap:8}}>
    <div style={{flex:1,minHeight:0,display:'flex',alignItems:'center',justifyContent:'center'}}>
      <Player ref={player} component={composition} inputProps={config.inputProps??{}} durationInFrames={config.durationInFrames} compositionWidth={config.width} compositionHeight={config.height} fps={config.fps} controls={false} autoPlay={false} loop={false} clickToPlay doubleClickToFullscreen={false} style={{width:'100%',maxHeight:'100%',aspectRatio:`${config.width}/${config.height}`}} />
    </div>
    <div style={{display:'flex',alignItems:'center',gap:12}}>
      <button onClick={()=>{if(playing)player.current?.pause();else {if(frame>=config.durationInFrames-1)player.current?.seekTo(0);player.current?.play();}}} style={{background:'#243d55',border:'1px solid #34506b',borderRadius:6,color:'#edf2fa',padding:'8px 14px',minWidth:72,cursor:'pointer'}}>{playing?'Pause':'Play'}</button>
      <input aria-label="Timeline" type="range" min={0} max={config.durationInFrames-1} value={frame} onChange={e=>{player.current?.pause();player.current?.seekTo(Number(e.target.value));}} style={{flex:1,minWidth:0,accentColor:'#69e3d3'}}/>
      <output style={{fontSize:12,fontVariantNumeric:'tabular-nums'}}>{Math.floor(frame/config.fps)} / {Math.ceil(config.durationInFrames/config.fps)} s</output>
    </div>
    {!!config.chapters?.length&&<nav aria-label="Chapters" style={{display:'flex',gap:6,flexWrap:'wrap',justifyContent:'center'}}>{config.chapters.map((chapter,i)=>{
      const active=frame>=chapter.frame&&frame<(config.chapters?.[i+1]?.frame??Infinity);
      return <button key={chapter.frame} aria-current={active?'step':undefined} onClick={()=>{player.current?.pause();player.current?.seekTo(chapter.frame);}} style={{background:active?'#243d55':'#142033',color:'#edf2fa',border:'1px solid #34506b',borderRadius:6,padding:'8px 10px',cursor:'pointer',fontSize:12}}>{chapter.label}</button>;
    })}</nav>}
  </main>;
}
export function mount(composition:React.ComponentType<any>,config:Config){
  createRoot(document.getElementById('root')!).render(<Boundary><Playback composition={composition} config={config}/></Boundary>);
}
