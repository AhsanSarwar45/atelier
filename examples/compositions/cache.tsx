import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
const move=(f:number,a:number,b:number,x:number,y:number)=>interpolate(f,[a,b],[x,y],{extrapolateLeft:'clamp',extrapolateRight:'clamp'});
/** A second subject demonstrates editable data and unrestricted SVG composition. */
export default function Cache({databaseMs=120,cacheMs=4}:{databaseMs?:number;cacheMs?:number}){
 const frame=useCurrentFrame(),hit=frame>=360,f=frame%360;
 const x=hit?(f<130?move(f,35,100,200,640):move(f,150,230,640,200)):(f<110?move(f,35,100,200,640):f<200?move(f,120,180,640,1080):move(f,220,310,1080,200));
 const stored=hit||f>=265;
 return <AbsoluteFill style={{background:'#10192a',color:'#f3f5fa',fontFamily:'Arial, sans-serif'}}>
 <div style={{position:'absolute',top:60,left:70,fontSize:46,fontWeight:700}}>{hit?'The same request takes a shorter path':'The first request needs the database'}</div>
 <svg width="1280" height="720" style={{position:'absolute',inset:0}}>
 <path d="M200 360H1080" stroke="#3e526e" strokeWidth="4"/>
 {[['App',200],['Cache',640],['Database',1080]].map(([label,cx])=><g key={label}><rect x={Number(cx)-95} y="285" width="190" height="150" rx="18" fill="#192a42" stroke={label==='Cache'&&stored?'#68dfc3':'#526882'} strokeWidth="2"/><text x={cx} y="365" textAnchor="middle" fill="#eef3fc" fontSize="30">{label}</text></g>)}
 <circle cx={x} cy="250" r="12" fill={hit?'#68dfc3':'#ffd180'}/><path d={`M${x} 265V281`} stroke="#ffd180" strokeWidth="2"/>
 <text x={640} y="475" textAnchor="middle" fill="#68dfc3" fontSize="25">{stored?'Result stored':f>100?'No saved result':''}</text>
 <text x={hit?420:860} y="210" textAnchor="middle" fill="#b9c7dc" fontSize="22">{f<100?'Request':hit?'Cached result':f<200?'Read database':'Return and store result'}</text>
 </svg>
 <div style={{position:'absolute',bottom:70,left:70,fontSize:30}}>{f>310?(hit?`${cacheMs} ms — database work avoided`:`${databaseMs} ms — result saved for next time`):hit?'Return the saved result.':'Fetch once, then save the result.'}</div>
 <div style={{position:'absolute',bottom:25,right:50,fontSize:17,color:'#90a5bf'}}>Illustrative timings · unchanged data</div>
 </AbsoluteFill>;
}
